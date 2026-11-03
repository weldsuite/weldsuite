//! Payroll journal import from a CSV export (`services/payroll/csv-import.ts`).
//!
//! `summary`: one row per payroll with its totals, posted through the account
//! mapping. `gl`: a general-ledger export grouped by date, one payroll per
//! date, each export account matched through the mapping, then by code or
//! name. The whole file is validated before anything posts; each payroll
//! then posts on its own, once (same date and amounts).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use weldsuite_books_domain::js::{math_round, number_value};
use weldsuite_books_domain::jurisdictions::{is_js_space, js_trim};
use weldsuite_books_domain::payroll::{PayrollError, PostPayrollArgs, post_payroll_import};
use weldsuite_books_domain::posting::{
    EntityAccounts, PostError, PostingLine, load_entity_accounts,
};

use super::csv::{ParsedCsv, column_index, parse_csv, parse_date, parse_money};
use super::journal::{
    GlLine, Totals, build_gl_lines, build_payroll_lines, line_json, payroll_error,
};
use super::mapping::CsvMapping;

/// Why an import stopped before posting anything.
#[derive(Debug)]
pub(crate) enum ImportError {
    /// `PayrollCsvValidationError`: every problem, by row.
    Rows(Vec<(usize, String)>),
    Post(PostError),
}

impl From<PostError> for ImportError {
    fn from(error: PostError) -> Self {
        Self::Post(error)
    }
}

impl From<sqlx::Error> for ImportError {
    fn from(error: sqlx::Error) -> Self {
        Self::Post(PostError::Database(error))
    }
}

/// `new PayrollCsvValidationError(problems).message`.
pub(crate) fn problems_message(problems: &[(usize, String)]) -> String {
    let listed: Vec<String> = problems
        .iter()
        .take(5)
        .map(|(row, message)| format!("row {row}: {message}"))
        .collect();
    format!(
        "The CSV has {} problem{}: {}{}",
        problems.len(),
        if problems.len() == 1 { "" } else { "s" },
        listed.join("; "),
        if problems.len() > 5 { "; ..." } else { "" }
    )
}

/// `CsvImportArgs`.
pub(crate) struct CsvImportArgs<'a> {
    pub(crate) entity_id: &'a str,
    pub(crate) user_id: Option<String>,
    pub(crate) csv: &'a str,
    pub(crate) mapping: &'a CsvMapping,
    pub(crate) period_start: Option<String>,
    pub(crate) period_end: Option<String>,
    pub(crate) source_file_name: Option<String>,
    pub(crate) batch_label: Option<String>,
    pub(crate) dry_run: bool,
}

/// One payroll the file imported (or would import, on a dry run).
pub(crate) struct Imported {
    pub(crate) import_id: Option<String>,
    pub(crate) journal_entry_id: Option<String>,
    pub(crate) entry_number: Option<String>,
    pub(crate) pay_date: String,
    summary: Value,
    total_debit: f64,
    lines: Vec<PostingLine>,
}

/// `CsvImportResult`.
pub(crate) struct CsvImportResult {
    shape: &'static str,
    dry_run: bool,
    pub(crate) imports: Vec<Imported>,
    pub(crate) duplicates: Vec<Value>,
    failed: Vec<Value>,
}

impl CsvImportResult {
    pub(crate) fn json(&self) -> Value {
        json!({
            "shape": self.shape,
            "dryRun": self.dry_run,
            "imports": self.imports.iter().map(|i| json!({
                "importId": i.import_id,
                "journalEntryId": i.journal_entry_id,
                "entryNumber": i.entry_number,
                "payDate": i.pay_date,
                "summary": i.summary,
                "totalDebit": number_value(i.total_debit),
                "lines": i.lines.iter().map(line_json).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "duplicates": self.duplicates,
            "failed": self.failed,
        })
    }
}

struct Prepared {
    pay_date: String,
    period_start: Option<String>,
    period_end: Option<String>,
    external_seed: String,
    lines: Vec<PostingLine>,
    summary: Value,
    description: String,
}

/// `JSON.stringify(text)`.
fn js_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// `JSON.stringify(number)`.
fn js_number(number: f64) -> String {
    weldsuite_books_domain::js::number_text(number)
}

/// The first 8 bytes of SHA-256, hex (`sha(text)`).
fn sha(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest[..8].iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn require_column(headers: &[String], name: Option<&str>, what: &str) -> Result<usize, PostError> {
    column_index(headers, name).ok_or_else(|| {
        let found = if headers.is_empty() {
            "none".to_owned()
        } else {
            headers.join(", ")
        };
        payroll_error(format!(
            "The CSV has no column \"{}\" ({what}). Columns found: {found}",
            name.unwrap_or_default()
        ))
    })
}

fn amount_at(row: &[String], index: Option<usize>, label: &str) -> Result<f64, String> {
    let Some(index) = index else {
        return Ok(0.0);
    };
    let value = parse_money(row.get(index).map(String::as_str))?;
    if value.is_some_and(|v| v < 0.0) {
        return Err(format!("{label} cannot be negative"));
    }
    Ok(value.unwrap_or(0.0))
}

fn prepare_summary(
    parsed: &ParsedCsv,
    mapping: &CsvMapping,
    accounts: &EntityAccounts,
    args: &CsvImportArgs<'_>,
) -> Result<Vec<Prepared>, ImportError> {
    let headers = &parsed.headers;
    let col = |key: &str| mapping.column(key);
    let pay_date_at = require_column(headers, col("payDate"), "pay date")?;
    let gross_at = require_column(headers, col("grossWages"), "gross wages")?;
    let net_at = require_column(headers, col("netPay"), "net pay")?;
    let at = |key: &str| column_index(headers, col(key));
    for (key, name) in &mapping.columns {
        if !name.is_empty() && column_index(headers, Some(name)).is_none() {
            return Err(payroll_error(format!(
                "The CSV has no column \"{name}\" ({key}). Columns found: {}",
                headers.join(", ")
            ))
            .into());
        }
    }
    let format = mapping.date_format.as_str();
    let mut problems: Vec<(usize, String)> = Vec::new();
    let mut prepared = Vec::new();
    for (offset, row) in parsed.rows.iter().enumerate() {
        let row_number = offset + 2;
        let result = (|| -> Result<Prepared, String> {
            let raw_date = row.get(pay_date_at).map(String::as_str);
            let pay_date = parse_date(raw_date, format)
                .ok_or_else(|| format!("\"{}\" is not a date", raw_date.unwrap_or_default()))?;
            let totals = Totals {
                gross_wages: amount_at(row, Some(gross_at), "Gross wages")?,
                net_pay: amount_at(row, Some(net_at), "Net pay")?,
                employer_taxes: amount_at(row, at("employerTaxes"), "Employer taxes")?,
                employee_taxes: amount_at(row, at("employeeTaxes"), "Employee taxes")?,
                employee_deductions: amount_at(
                    row,
                    at("employeeDeductions"),
                    "Employee deductions",
                )?,
                employer_benefits: amount_at(row, at("employerBenefits"), "Employer benefits")?,
                reimbursements: amount_at(row, at("reimbursements"), "Reimbursements")?,
                owners_draw: amount_at(row, at("ownersDraw"), "Owner's draw")?,
            };
            let reference = at("reference")
                .map(|i| js_trim(row.get(i).map_or("", String::as_str)).to_owned())
                .unwrap_or_default();
            let lines = build_payroll_lines(
                &totals,
                accounts,
                &mapping.accounts,
                &format!("Payroll {pay_date}"),
            )
            .map_err(|error| error.to_string())?;
            let period = |key: &str, fallback: &Option<String>| {
                at(key)
                    .and_then(|i| parse_date(row.get(i).map(String::as_str), format))
                    .or_else(|| fallback.clone())
            };
            let summary_text = format!(
                "{{{}}}",
                totals
                    .summary()
                    .iter()
                    .map(|(k, v)| format!("{}:{}", js_string(k), js_number(*v)))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            Ok(Prepared {
                period_start: period("periodStart", &args.period_start),
                period_end: period("periodEnd", &args.period_end),
                external_seed: format!(
                    "[{},{},{summary_text}]",
                    js_string(&pay_date),
                    js_string(&reference)
                ),
                lines,
                summary: totals.summary_json(),
                description: if reference.is_empty() {
                    format!("Payroll {pay_date}")
                } else {
                    format!("Payroll {pay_date} ({reference})")
                },
                pay_date,
            })
        })();
        match result {
            Ok(item) => prepared.push(item),
            Err(message) => problems.push((row_number, message)),
        }
    }
    if !problems.is_empty() {
        return Err(ImportError::Rows(problems));
    }
    Ok(prepared)
}

/// `resolveAccountLabel(label, mapped, accounts, names)`: the mapping, then
/// an account code, then a name.
fn resolve_account_label(
    label: &str,
    mapped: &[(String, String)],
    accounts: &EntityAccounts,
    names: &HashMap<String, String>,
) -> Option<String> {
    let wanted = js_trim(label);
    let owned = |id: &str| accounts.by_id(Some(id)).map(|_| id.to_owned());
    if let Some((_, direct)) = mapped
        .iter()
        .rev()
        .find(|(k, v)| k == wanted && !v.is_empty())
    {
        return owned(direct);
    }
    let lower = wanted.to_lowercase();
    if let Some((_, id)) = mapped.iter().find(|(k, _)| k.to_lowercase() == lower) {
        return owned(id);
    }
    let first = wanted
        .split(|c: char| is_js_space(c) || c == ':' || c == '-')
        .next()
        .unwrap_or_default();
    if let Some(account) = accounts.by_code(wanted).or_else(|| accounts.by_code(first)) {
        return account["id"].as_str().map(str::to_owned);
    }
    names.get(&lower).cloned()
}

fn prepare_gl(
    parsed: &ParsedCsv,
    mapping: &CsvMapping,
    accounts: &EntityAccounts,
    names: &HashMap<String, String>,
    args: &CsvImportArgs<'_>,
) -> Result<Vec<Prepared>, ImportError> {
    let headers = &parsed.headers;
    let col = |key: &str| mapping.column(key);
    let date_at = require_column(headers, col("date"), "date")?;
    let account_at = require_column(headers, col("account"), "account")?;
    let debit_at = require_column(headers, col("debit"), "debit")?;
    let credit_at = require_column(headers, col("credit"), "credit")?;
    let memo_at = column_index(headers, col("memo"));
    let format = mapping.date_format.as_str();

    let mut problems: Vec<(usize, String)> = Vec::new();
    let mut by_date: Vec<(String, Vec<GlLine>)> = Vec::new();
    for (offset, row) in parsed.rows.iter().enumerate() {
        let row_number = offset + 2;
        let cell = |i: usize| row.get(i).map(String::as_str);
        let result = (|| -> Result<(String, GlLine), String> {
            let pay_date = parse_date(cell(date_at), format).ok_or_else(|| {
                format!("\"{}\" is not a date", cell(date_at).unwrap_or_default())
            })?;
            let label = js_trim(cell(account_at).unwrap_or_default()).to_owned();
            if label.is_empty() {
                return Err("The account is empty".to_owned());
            }
            let account_id = resolve_account_label(&label, &mapping.accounts, accounts, names)
                .ok_or_else(|| format!("No account matches \"{label}\"; map it to an account"))?;
            let debit = parse_money(cell(debit_at))?.unwrap_or(0.0);
            let credit = parse_money(cell(credit_at))?.unwrap_or(0.0);
            let memo = memo_at
                .map(|i| js_trim(cell(i).unwrap_or_default()).to_owned())
                .filter(|m| !m.is_empty());
            Ok((
                pay_date,
                GlLine {
                    account_id,
                    debit,
                    credit,
                    memo,
                    label,
                },
            ))
        })();
        match result {
            Ok((pay_date, line)) => {
                if let Some(group) = by_date.iter_mut().find(|(d, _)| *d == pay_date) {
                    group.1.push(line);
                } else {
                    by_date.push((pay_date, vec![line]));
                }
            }
            Err(message) => problems.push((row_number, message)),
        }
    }
    if !problems.is_empty() {
        return Err(ImportError::Rows(problems));
    }

    by_date.sort_by(|a, b| a.0.cmp(&b.0));
    let mut prepared = Vec::new();
    for (pay_date, group) in by_date {
        let lines = build_gl_lines(&group, &format!("Payroll {pay_date}"))
            .map_err(|error| payroll_error(format!("{pay_date}: {error}")))?;
        let mut summary: Vec<(String, f64)> = Vec::new();
        for line in &group {
            let at = summary.iter().position(|(l, _)| *l == line.label);
            let previous = at.map_or(0.0, |i| summary[i].1);
            let value = math_round((previous + line.debit - line.credit) * 100.0) / 100.0;
            match at {
                Some(i) => summary[i].1 = value,
                None => summary.push((line.label.clone(), value)),
            }
        }
        let seed_lines: Vec<String> = group
            .iter()
            .map(|l| {
                format!(
                    "[{},{},{}]",
                    js_string(&l.account_id),
                    js_number(l.debit),
                    js_number(l.credit)
                )
            })
            .collect();
        prepared.push(Prepared {
            period_start: args.period_start.clone(),
            period_end: args.period_end.clone(),
            external_seed: format!("[{},[{}]]", js_string(&pay_date), seed_lines.join(",")),
            lines,
            summary: Value::Object(
                summary
                    .into_iter()
                    .map(|(k, v)| (k, number_value(v)))
                    .collect(),
            ),
            description: format!("Payroll {pay_date}"),
            pay_date,
        });
    }
    Ok(prepared)
}

/// `importPayrollCsv(db, args)`.
#[allow(clippy::too_many_lines)] // the service step for step: parse, prepare, post each payroll
pub(crate) async fn import_payroll_csv(
    db: &PgPool,
    args: CsvImportArgs<'_>,
) -> Result<CsvImportResult, ImportError> {
    let parsed = parse_csv(args.csv);
    if parsed.headers.is_empty() || parsed.rows.is_empty() {
        return Err(payroll_error("The CSV is empty").into());
    }
    let accounts = load_entity_accounts(db, args.entity_id).await?;
    let account_rows: Vec<(String, String)> =
        sqlx::query_as("select id, name from accounts where entity_id = $1 and deleted_at is null")
            .bind(args.entity_id)
            .fetch_all(db)
            .await?;
    let names: HashMap<String, String> = account_rows
        .into_iter()
        .map(|(id, name)| (js_trim(&name).to_lowercase(), id))
        .collect();

    let prepared = if args.mapping.shape == "summary" {
        prepare_summary(&parsed, args.mapping, &accounts, &args)?
    } else {
        prepare_gl(&parsed, args.mapping, &accounts, &names, &args)?
    };

    let mut result = CsvImportResult {
        shape: args.mapping.shape,
        dry_run: args.dry_run,
        imports: Vec::new(),
        duplicates: Vec::new(),
        failed: Vec::new(),
    };
    let mut seen: HashSet<String> = HashSet::new();
    for item in prepared {
        let external_id = format!(
            "{}:{}",
            item.pay_date,
            sha(&format!(
                "{}|{}",
                item.external_seed,
                args.batch_label.as_deref().unwrap_or_default()
            ))
        );
        if !seen.insert(external_id.clone()) {
            result.failed.push(json!({
                "payDate": item.pay_date,
                "error": "The CSV has this payroll twice (same date and amounts); add a reference column to tell them apart",
            }));
            continue;
        }
        let total_debit =
            math_round(item.lines.iter().fold(0.0, |sum, l| sum + l.debit) * 100.0) / 100.0;
        if args.dry_run {
            result.imports.push(Imported {
                import_id: None,
                journal_entry_id: None,
                entry_number: None,
                pay_date: item.pay_date,
                summary: item.summary,
                total_debit,
                lines: item.lines,
            });
            continue;
        }
        let posted = post_payroll_import(
            db,
            PostPayrollArgs {
                entity_id: args.entity_id.to_owned(),
                user_id: args.user_id.clone(),
                source: "csv".to_owned(),
                connection_id: None,
                external_id,
                pay_date: item.pay_date.clone(),
                period_start: item.period_start.clone(),
                period_end: item.period_end.clone(),
                lines: item.lines.clone(),
                summary: item.summary.clone(),
                source_file_name: args.source_file_name.clone(),
                description: item.description.clone(),
                reference: None,
            },
        )
        .await;
        match posted {
            Ok(posted) => result.imports.push(Imported {
                import_id: Some(posted.import_id),
                journal_entry_id: Some(posted.journal_entry_id),
                entry_number: posted.entry_number,
                pay_date: item.pay_date,
                summary: item.summary,
                total_debit,
                lines: item.lines,
            }),
            Err(PayrollError::Duplicate { id, status }) => result.duplicates.push(json!({
                "payDate": item.pay_date,
                "importId": id,
                "status": status,
            })),
            Err(PayrollError::Post(error)) => match error.user_message() {
                Some(message) => result
                    .failed
                    .push(json!({ "payDate": item.pay_date, "error": message })),
                None => return Err(error.into()),
            },
        }
    }
    Ok(result)
}
