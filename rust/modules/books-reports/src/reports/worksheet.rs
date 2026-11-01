//! The income-tax return worksheet (`services/accounting-tax-worksheet.ts`):
//! a fiscal year's trial balance grouped by the lines of the entity's return
//! (Schedule C, 1065, 1120-S, 1120 or 990), with the accounts behind every
//! line. Amounts read the way the form shows them; balance sheet lines
//! (Schedule L) carry the year-end and the beginning-of-year balance; the
//! retained earnings line carries the result never closed to equity as a
//! calculated row.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_books_domain::dates::{add_days, parse_iso};
use weldsuite_books_domain::jurisdictions::us;
use weldsuite_books_domain::reports_basis::{
    AggregateOptions, DateRange, Edge, Ledger, LedgerAccount, LedgerRange, money, numeric_compare,
    parse_report_date,
};

use super::build::{BuildError, Built};
use super::export::{Table, TableColumn, TableRow};

const BALANCE_SHEET_TYPES: [&str; 3] = ["asset", "liability", "equity"];

/// Id of the calculated row on the retained earnings line.
const CALCULATED_RESULT_ID: &str = "calculated_net_income";

const SECTION_ORDER: [&str; 8] = [
    "income",
    "other_income",
    "cogs",
    "deduction",
    "other_deduction",
    "not_deductible",
    "balance_sheet",
    "equity",
];

/// `SECTION_SIDE`: the side a section normally carries.
fn section_side(section: &str) -> &'static str {
    match section {
        "income" | "other_income" | "equity" => "credit",
        _ => "debit",
    }
}

fn section_label(section: &str) -> String {
    us::section_label(section)
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// `TaxWorksheetAccount`.
struct WorksheetAccount {
    account_id: String,
    code: String,
    name: String,
    account_type: String,
    amount: String,
    beginning_amount: Option<String>,
}

/// `TaxWorksheetLine`.
struct WorksheetLine {
    code: String,
    line: Value,
    label: Value,
    section: String,
    side: &'static str,
    amount: String,
    beginning_amount: Option<String>,
    deductible: Option<(f64, String, String, Option<String>)>,
    accounts: Vec<WorksheetAccount>,
}

impl WorksheetLine {
    fn json(&self) -> Value {
        let mut object = Map::new();
        object.insert("code".to_owned(), json!(self.code));
        object.insert("line".to_owned(), self.line.clone());
        object.insert("label".to_owned(), self.label.clone());
        object.insert("section".to_owned(), json!(self.section));
        object.insert("side".to_owned(), json!(self.side));
        object.insert("amount".to_owned(), json!(self.amount));
        if let Some(beginning) = &self.beginning_amount {
            object.insert("beginningAmount".to_owned(), json!(beginning));
        }
        if let Some((percent, deductible, non_deductible, line)) = &self.deductible {
            object.insert(
                "deductiblePercent".to_owned(),
                weldsuite_books_domain::js::number_value(*percent),
            );
            object.insert("deductibleAmount".to_owned(), json!(deductible));
            object.insert("nonDeductibleAmount".to_owned(), json!(non_deductible));
            if let Some(line) = line {
                object.insert("nonDeductibleLine".to_owned(), json!(line));
            }
        }
        object.insert(
            "accounts".to_owned(),
            Value::Array(
                self.accounts
                    .iter()
                    .map(|a| {
                        let mut account = json!({
                            "accountId": a.account_id,
                            "code": a.code,
                            "name": a.name,
                            "type": a.account_type,
                            "amount": a.amount,
                        });
                        if let Some(beginning) = &a.beginning_amount {
                            account["beginningAmount"] = json!(beginning);
                        }
                        account
                    })
                    .collect(),
            ),
        );
        Value::Object(object)
    }
}

/// `TaxWorksheetSection`.
struct WorksheetSection {
    key: &'static str,
    label: String,
    lines: Vec<usize>,
    total: Option<String>,
}

/// `TaxWorksheetUnmapped`.
struct Unmapped {
    account_id: String,
    code: String,
    name: String,
    account_type: String,
    tax_line: Option<String>,
    reason: &'static str,
    amount: String,
    beginning_amount: Option<String>,
}

/// `TaxWorksheet`.
pub(crate) struct Worksheet {
    pub(crate) form: &'static str,
    pub(crate) form_label: String,
    pub(crate) tax_year: i64,
    pub(crate) basis: &'static str,
    pub(crate) period: DateRange,
    entity: Value,
    lines: Vec<WorksheetLine>,
    sections: Vec<WorksheetSection>,
    unmapped: Vec<Unmapped>,
    summary: Summary,
}

struct Summary {
    net_income_per_books: String,
    total_income: String,
    total_other_income: String,
    total_cost_of_goods_sold: String,
    total_deductions: String,
    net_income_from_lines: String,
    not_deductible_total: String,
    unmapped_net_income: String,
    reconciles: bool,
}

impl Worksheet {
    pub(crate) fn json(&self) -> Value {
        let sections: Vec<Value> = self
            .sections
            .iter()
            .map(|s| {
                json!({
                    "key": s.key,
                    "label": s.label,
                    "lines": s.lines.iter().map(|&i| self.lines[i].json()).collect::<Vec<_>>(),
                    "total": s.total,
                })
            })
            .collect();
        let unmapped: Vec<Value> = self
            .unmapped
            .iter()
            .map(|u| {
                let mut row = json!({
                    "accountId": u.account_id,
                    "code": u.code,
                    "name": u.name,
                    "type": u.account_type,
                    "taxLine": u.tax_line,
                    "reason": u.reason,
                    "amount": u.amount,
                });
                if let Some(beginning) = &u.beginning_amount {
                    row["beginningAmount"] = json!(beginning);
                }
                row
            })
            .collect();
        let s = &self.summary;
        json!({
            "form": self.form,
            "formLabel": self.form_label,
            "taxYear": self.tax_year,
            "basis": self.basis,
            "period": self.period.json(),
            "entity": self.entity,
            "sections": sections,
            "unmapped": unmapped,
            "summary": {
                "netIncomePerBooks": s.net_income_per_books,
                "totalIncome": s.total_income,
                "totalOtherIncome": s.total_other_income,
                "totalCostOfGoodsSold": s.total_cost_of_goods_sold,
                "totalDeductions": s.total_deductions,
                "netIncomeFromLines": s.net_income_from_lines,
                "notDeductibleTotal": s.not_deductible_total,
                "unmappedNetIncome": s.unmapped_net_income,
                "reconciles": s.reconciles,
            },
        })
    }
}

/// `limitedLines(form, taxYear)`: lines that only partly count (meals),
/// unless a fully deductible category shares the line.
fn limited_lines(form: &str, tax_year: i64) -> HashMap<String, (f64, Option<String>)> {
    let mut limited: Vec<(String, (f64, Option<String>))> = Vec::new();
    let mut full: Vec<String> = Vec::new();
    for category in us::tax_line_categories() {
        let Some(line) = us::resolve_tax_line(category, form, tax_year) else {
            continue;
        };
        let code = line["code"].as_str().unwrap_or_default().to_owned();
        let percent = deductible_percent(category);
        if percent < 100.0 {
            let non_deductible = nondeductible_line(category, form, tax_year);
            if let Some(entry) = limited.iter_mut().find(|(c, _)| *c == code) {
                entry.1 = (percent, non_deductible);
            } else {
                limited.push((code, (percent, non_deductible)));
            }
        } else if !full.contains(&code) {
            full.push(code);
        }
    }
    limited
        .into_iter()
        .filter(|(code, _)| !full.contains(code))
        .collect()
}

/// `getDeductiblePercent(category)`.
fn deductible_percent(category: &str) -> f64 {
    if category == "meals" { 50.0 } else { 100.0 }
}

/// `resolveNondeductibleLine(category, form, taxYear)`.
fn nondeductible_line(category: &str, form: &str, tax_year: i64) -> Option<String> {
    if deductible_percent(category) >= 100.0 {
        return None;
    }
    let target = match form {
        "f1065" => "f1065.k18c",
        "f1120s" => "f1120s.k16c",
        "f1120" => "f1120.m1_5c",
        _ => return None,
    };
    us::tax_line(target, tax_year).and_then(|line| line["code"].as_str().map(str::to_owned))
}

/// `Placed`.
struct Placed<'a> {
    account: &'a LedgerAccount,
    net: f64,
    beginning_net: Option<f64>,
}

type Balances = HashMap<String, (f64, f64)>;

fn balances_of(rows: Vec<weldsuite_books_domain::reports_basis::AggregateRow>) -> Balances {
    rows.into_iter()
        .map(|r| (r.account_id, (r.debit, r.credit)))
        .collect()
}

/// `buildTaxWorksheet(ledger, entity, form, range, includeZero)`.
#[allow(clippy::too_many_lines)] // the TypeScript builder and its helpers, step for step
pub(crate) async fn build_tax_worksheet(
    ledger: &Ledger,
    entity: Value,
    form: &'static str,
    range: &DateRange,
    include_zero: bool,
) -> Built<Worksheet> {
    let tax_year = parse_iso(&range.from)
        .ok_or_else(|| BuildError::Internal(format!("Invalid date {}", range.from)))?
        .y;
    let catalog = us::tax_line_catalog(form, tax_year);
    let limits = limited_lines(form, tax_year);

    let from = parse_report_date(&range.from, Edge::Start)?;
    let to = parse_report_date(&range.to, Edge::End)?;
    let activity = balances_of(
        ledger
            .aggregate(
                LedgerRange {
                    from: Some(from),
                    to,
                },
                AggregateOptions::types(&["revenue", "expense"]),
            )
            .await?,
    );
    let end = balances_of(
        ledger
            .aggregate(
                LedgerRange { from: None, to },
                AggregateOptions::types(&BALANCE_SHEET_TYPES),
            )
            .await?,
    );
    let start = balances_of(
        ledger
            .aggregate(
                LedgerRange {
                    from: None,
                    to: from - 1,
                },
                AggregateOptions::types(&BALANCE_SHEET_TYPES),
            )
            .await?,
    );

    // placeAccounts
    let mut placed: Vec<Placed<'_>> = Vec::new();
    for account in ledger.accounts() {
        let is_balance_sheet = BALANCE_SHEET_TYPES.contains(&account.account_type.as_str());
        let totals = if is_balance_sheet {
            end.get(&account.id)
        } else {
            activity.get(&account.id)
        };
        let starting = if is_balance_sheet {
            start.get(&account.id)
        } else {
            None
        };
        let net = totals.map_or(0.0, |t| t.0) - totals.map_or(0.0, |t| t.1);
        let beginning_net = match starting {
            Some((debit, credit)) => Some(debit - credit),
            None if is_balance_sheet => Some(0.0),
            None => None,
        };
        let has_amount = net.abs() >= 0.005 || beginning_net.unwrap_or(0.0).abs() >= 0.005;
        if !has_amount && !include_zero {
            continue;
        }
        placed.push(Placed {
            account,
            net,
            beginning_net,
        });
    }
    placed.sort_by(|a, b| numeric_compare(&a.account.code, &b.account.code));

    // mapAccountsToLines
    let catalog_codes: Vec<&str> = catalog
        .iter()
        .filter_map(|line| line["code"].as_str())
        .collect();
    let mut by_line: HashMap<String, Vec<usize>> = HashMap::new();
    let mut unmapped: Vec<Unmapped> = Vec::new();
    let mut unmapped_ids: Vec<String> = Vec::new();
    for (i, p) in placed.iter().enumerate() {
        let code = p.account.tax_line.as_deref().filter(|c| !c.is_empty());
        if let Some(code) = code.filter(|c| catalog_codes.contains(c)) {
            by_line.entry(code.to_owned()).or_default().push(i);
            continue;
        }
        if form == "sch_c" && BALANCE_SHEET_TYPES.contains(&p.account.account_type.as_str()) {
            continue;
        }
        let credit = p.account.normal_side == "credit";
        let reason = match code {
            None => "none",
            Some(code) if us::tax_line(code, tax_year).is_some() => "other_form",
            Some(_) => "unknown_line",
        };
        unmapped_ids.push(p.account.id.clone());
        unmapped.push(Unmapped {
            account_id: p.account.id.clone(),
            code: p.account.code.clone(),
            name: p.account.name.clone(),
            account_type: p.account.account_type.clone(),
            tax_line: p.account.tax_line.clone(),
            reason,
            amount: money(if credit { -p.net } else { p.net }),
            beginning_amount: p.beginning_net.map(|b| money(if credit { -b } else { b })),
        });
    }

    // buildWorksheetLine
    let mut lines: Vec<WorksheetLine> = catalog
        .iter()
        .map(|def| {
            let code = def["code"].as_str().unwrap_or_default().to_owned();
            let section = def["section"].as_str().unwrap_or_default().to_owned();
            let members: Vec<&Placed<'_>> = by_line
                .get(&code)
                .map(|ids| ids.iter().map(|&i| &placed[i]).collect())
                .unwrap_or_default();
            let natural = section_side(&section);
            let only_contra =
                !members.is_empty() && members.iter().all(|m| m.account.normal_side != natural);
            let side = if !only_contra {
                natural
            } else if natural == "credit" {
                "debit"
            } else {
                "credit"
            };
            let signed = |net: f64| if side == "debit" { net } else { -net };
            let amount = members.iter().fold(0.0, |t, m| t + signed(m.net));
            let is_balance_sheet = section == "balance_sheet" || section == "equity";
            let beginning = members
                .iter()
                .fold(0.0, |t, m| t + signed(m.beginning_net.unwrap_or(0.0)));
            let deductible = limits.get(&code).filter(|_| !members.is_empty()).map(
                |(percent, non_deductible_line)| {
                    let deductible = (amount * percent) / 100.0;
                    (
                        *percent,
                        money(deductible),
                        money(amount - deductible),
                        non_deductible_line.clone(),
                    )
                },
            );
            WorksheetLine {
                line: def.get("line").cloned().unwrap_or(Value::Null),
                label: def.get("label").cloned().unwrap_or(Value::Null),
                side,
                amount: money(amount),
                beginning_amount: is_balance_sheet.then(|| money(beginning)),
                deductible,
                accounts: members
                    .iter()
                    .map(|m| WorksheetAccount {
                        account_id: m.account.id.clone(),
                        code: m.account.code.clone(),
                        name: m.account.name.clone(),
                        account_type: m.account.account_type.clone(),
                        amount: money(signed(m.net)),
                        beginning_amount: m.beginning_net.map(|b| money(signed(b))),
                    })
                    .collect(),
                code,
                section,
            }
        })
        .collect();

    // addCalculatedResult
    let retained = if form == "sch_c" {
        None
    } else {
        us::resolve_tax_line("bs_retained_earnings", form, tax_year)
            .and_then(|def| def["code"].as_str())
    };
    if let Some(at) = retained.and_then(|code| lines.iter().position(|l| l.code == code)) {
        let result = |rows: Vec<weldsuite_books_domain::reports_basis::AggregateRow>| {
            rows.iter().fold(0.0, |sum, r| sum + r.credit - r.debit)
        };
        let to_end = result(
            ledger
                .aggregate(
                    LedgerRange { from: None, to },
                    AggregateOptions::types(&["revenue", "expense"]),
                )
                .await?,
        );
        let to_start = result(
            ledger
                .aggregate(
                    LedgerRange {
                        from: None,
                        to: from - 1,
                    },
                    AggregateOptions::types(&["revenue", "expense"]),
                )
                .await?,
        );
        if to_end.abs() >= 0.005 || to_start.abs() >= 0.005 {
            let line = &mut lines[at];
            let orient = |credit: f64| {
                if line.side == "credit" {
                    credit
                } else {
                    -credit
                }
            };
            let (end_amount, start_amount) = (orient(to_end), orient(to_start));
            line.amount = money(weldsuite_books_domain::js::parse_float(&line.amount) + end_amount);
            let beginning = line
                .beginning_amount
                .as_deref()
                .map_or(0.0, weldsuite_books_domain::js::parse_float);
            line.beginning_amount = Some(money(beginning + start_amount));
            line.accounts.push(WorksheetAccount {
                account_id: CALCULATED_RESULT_ID.to_owned(),
                code: String::new(),
                name: "Net income not yet closed to retained earnings".to_owned(),
                account_type: "equity".to_owned(),
                amount: money(end_amount),
                beginning_amount: Some(money(start_amount)),
            });
        }
    }

    // buildSections
    let mut sections: Vec<WorksheetSection> = Vec::new();
    for key in SECTION_ORDER {
        let members: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.section == key)
            .map(|(i, _)| i)
            .collect();
        if members.is_empty() {
            continue;
        }
        let total = members.iter().fold(0.0, |sum, &i| {
            let l = &lines[i];
            let amount = weldsuite_books_domain::js::parse_float(&l.amount);
            if l.side == section_side(key) {
                sum + amount
            } else {
                sum - amount
            }
        });
        sections.push(WorksheetSection {
            key,
            label: section_label(key),
            lines: members,
            total: (key != "balance_sheet").then(|| money(total)),
        });
    }

    // summarize
    let section_total = |key: &str| {
        sections
            .iter()
            .find(|s| s.key == key)
            .and_then(|s| s.total.as_deref())
            .map_or(0.0, weldsuite_books_domain::js::parse_float)
    };
    let total_income = section_total("income");
    let total_other_income = section_total("other_income");
    let total_cogs = section_total("cogs");
    let total_deductions = section_total("deduction") + section_total("other_deduction");
    let net_from_lines = total_income + total_other_income - total_cogs - total_deductions;
    let not_deductible = section_total("not_deductible");
    let profit_of = |rows: &mut dyn Iterator<Item = &Placed<'_>>| {
        let mut net = 0.0;
        for p in rows {
            if p.account.account_type == "revenue" || p.account.account_type == "expense" {
                net -= p.net;
            }
        }
        net
    };
    let books_net = profit_of(&mut placed.iter());
    let unmapped_net = profit_of(
        &mut unmapped_ids
            .iter()
            .filter_map(|id| placed.iter().find(|p| &p.account.id == id)),
    );

    let worksheet_entity = json!({
        "id": entity.get("id"),
        "name": entity.get("name"),
        "legalName": entity.get("legalName"),
        "entityType": entity.get("entityType"),
        "taxClassification": entity.get("taxClassification"),
    });
    Ok(Worksheet {
        form,
        form_label: us::form_label(form).to_owned(),
        tax_year,
        basis: ledger.basis.as_str(),
        period: range.clone(),
        entity: worksheet_entity,
        lines,
        sections,
        unmapped,
        summary: Summary {
            net_income_per_books: money(books_net),
            total_income: money(total_income),
            total_other_income: money(total_other_income),
            total_cost_of_goods_sold: money(total_cogs),
            total_deductions: money(total_deductions),
            net_income_from_lines: money(net_from_lines),
            not_deductible_total: money(not_deductible),
            unmapped_net_income: money(unmapped_net),
            reconciles: (books_net - (net_from_lines - not_deductible + unmapped_net)).abs() < 0.01,
        },
    })
}

/// `taxWorksheetTable(worksheet)`.
#[allow(clippy::too_many_lines)] // the export layout, row by row as TypeScript builds it
pub(crate) fn tax_worksheet_table(worksheet: &Worksheet) -> Table {
    let has_beginning = worksheet.sections.iter().any(|s| {
        s.lines
            .iter()
            .any(|&i| worksheet.lines[i].beginning_amount.is_some())
    });
    let mut columns = vec![
        TableColumn::new("line", "Line", false),
        TableColumn::new("amount", "Amount", true),
    ];
    if has_beginning {
        columns.push(TableColumn::new("beginning", "Beginning of year", true));
    }
    columns.push(TableColumn::new("deductible", "Deductible", true));

    let opt = |value: &Option<String>| value.clone().map_or(Value::Null, Value::String);
    let mut rows: Vec<TableRow> = Vec::new();
    for section in &worksheet.sections {
        rows.push(TableRow::new("section", 0, section.label.clone()));
        for &i in &section.lines {
            let line = &worksheet.lines[i];
            rows.push(
                TableRow::new(
                    "account",
                    0,
                    line.label.as_str().unwrap_or_default().to_owned(),
                )
                .code(json!(line.code))
                .value("line", line.line.clone())
                .value("amount", line.amount.clone())
                .value("beginning", opt(&line.beginning_amount))
                .value(
                    "deductible",
                    line.deductible
                        .as_ref()
                        .map_or(Value::Null, |(_, d, _, _)| json!(d)),
                ),
            );
            for account in &line.accounts {
                rows.push(
                    TableRow::new(
                        "note",
                        1,
                        format!("{} {}", account.code, account.name)
                            .trim()
                            .to_owned(),
                    )
                    .value("amount", account.amount.clone())
                    .value("beginning", opt(&account.beginning_amount)),
                );
            }
        }
        if let Some(total) = &section.total {
            rows.push(
                TableRow::new(
                    "subtotal",
                    0,
                    format!("Total {}", section.label.to_lowercase()),
                )
                .value("amount", total.clone()),
            );
        }
    }
    if !worksheet.unmapped.is_empty() {
        rows.push(TableRow::new("section", 0, "Accounts without a tax line"));
        for u in &worksheet.unmapped {
            rows.push(
                TableRow::new(
                    "note",
                    1,
                    format!("{} {}", u.code, u.name).trim().to_owned(),
                )
                .value("amount", u.amount.clone())
                .value("beginning", opt(&u.beginning_amount)),
            );
        }
    }
    let s = &worksheet.summary;
    rows.push(TableRow::new("section", 0, "Summary"));
    rows.push(
        TableRow::new("subtotal", 0, "Net income per books")
            .value("amount", s.net_income_per_books.clone()),
    );
    rows.push(
        TableRow::new("subtotal", 0, "Net income from tax lines")
            .value("amount", s.net_income_from_lines.clone()),
    );
    rows.push(
        TableRow::new("subtotal", 0, "Not deductible")
            .value("amount", s.not_deductible_total.clone()),
    );
    rows.push(
        TableRow::new("subtotal", 0, "Accounts without a tax line (net)")
            .value("amount", s.unmapped_net_income.clone()),
    );

    let beginning_date = add_days(&worksheet.period.from, -1).unwrap_or_default();
    let mut notes = vec![
        format!(
            "{}, tax year {}, {} basis.",
            worksheet.form_label, worksheet.tax_year, worksheet.basis
        ),
        format!(
            "Fiscal year {} to {}; balance sheet lines are as of {}, beginning amounts as of {}.",
            worksheet.period.from, worksheet.period.to, worksheet.period.to, beginning_date
        ),
    ];
    if !s.reconciles {
        notes.push(
            "The lines do not reconcile to net income per books; check the accounts without a tax line."
                .to_owned(),
        );
    }
    Table {
        report: "tax_worksheet",
        title: format!("Tax return worksheet: {}", worksheet.form_label),
        has_code: true,
        columns,
        rows,
        notes,
    }
}
