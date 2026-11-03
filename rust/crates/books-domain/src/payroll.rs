//! Imported payrolls (books-api `services/payroll/{imports,weldhr,mapping,
//! journal,errors}.ts` and `routes/payroll/internal.ts`): one payroll is one
//! journal entry (posting key `payroll:<importId>`) and one `payroll_imports`
//! row, written atomically; (entity, source, external id) posts once.
//!
//! [`post_weldhr_import`] is what hr-api's `BOOKS_INTERNAL` call
//! (`POST /internal/payroll/imports`) does, for the Rust hr module to call in
//! process: there is no service binding between modules of one binary. The
//! CSV and Gusto imports (the payroll routes) build their lines in the
//! reports area and post through [`post_payroll_import`] too.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::guards::{AuditInput, PostingLockKind, write_audit};
use crate::http::now;
use crate::js::{math_round, to_fixed};
use crate::posting::{
    AlsoWrite, EntityAccounts, PostError, PostJournalEntryInput, PostingLine, ReverseArgs,
    account_for_role, load_entity_accounts, post_journal_entry, reverse_journal_entry,
};
use crate::tables::PAYROLL_IMPORTS;

/// `PAYROLL_CATEGORIES`: a payroll summary's categories and their labels.
pub const PAYROLL_CATEGORIES: [(&str, &str); 9] = [
    ("gross_wages", "Gross wages"),
    ("employer_taxes", "Employer payroll taxes"),
    ("employer_benefits", "Employer benefits"),
    ("reimbursements", "Expense reimbursements"),
    ("owners_draw", "Owner's draw"),
    ("employee_taxes", "Employee taxes withheld"),
    ("employee_deductions", "Employee deductions"),
    ("payroll_liabilities", "Payroll liabilities"),
    ("net_pay", "Net pay (bank or payroll clearing)"),
];

/// The label of a category (`PAYROLL_CATEGORIES[category]`).
pub fn category_label(category: &str) -> &'static str {
    PAYROLL_CATEGORIES
        .iter()
        .find(|(key, _)| *key == category)
        .map_or("", |(_, label)| label)
}

/// Category to account id, in the order given (`AccountMapping`).
pub type AccountMapping = Vec<(String, String)>;

fn mapped_id<'a>(mapping: &'a AccountMapping, category: &str) -> Option<&'a str> {
    mapping
        .iter()
        .rev()
        .find(|(key, _)| key == category)
        .map(|(_, id)| id.as_str())
        .filter(|id| !id.is_empty())
}

fn failure(message: impl Into<String>) -> PostError {
    // `PayrollImportError`: the caller's data, answered with a 400 like a `PostingError`.
    PostError::Posting(message.into())
}

/// `Math.round(value * 100 ± 1e-9)`.
fn cents(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    let cents = math_round(value * 100.0 + if value >= 0.0 { 1e-9 } else { -1e-9 }) as i64;
    cents
}

#[allow(clippy::cast_precision_loss)]
fn amount(cents: i64) -> f64 {
    cents as f64 / 100.0
}

/// `resolverFor(accounts, mapping)`: the account each category posts to.
pub struct Resolver<'a> {
    accounts: &'a EntityAccounts,
    mapping: &'a AccountMapping,
}

impl<'a> Resolver<'a> {
    pub fn new(accounts: &'a EntityAccounts, mapping: &'a AccountMapping) -> Self {
        Self { accounts, mapping }
    }

    fn mapped(&self, category: &str) -> Result<Option<String>, PostError> {
        let Some(id) = mapped_id(self.mapping, category) else {
            return Ok(None);
        };
        if self.accounts.by_id(Some(id)).is_none() {
            return Err(failure(format!(
                "The account mapped to {category} does not belong to this accounting entity"
            )));
        }
        Ok(Some(id.to_owned()))
    }

    fn role(&self, role: &str) -> Option<String> {
        account_for_role(self.accounts, role, &[])
            .and_then(|a| a["id"].as_str())
            .map(str::to_owned)
    }

    fn wages(&self) -> Result<Option<String>, PostError> {
        Ok(self
            .mapped("gross_wages")?
            .or_else(|| self.role("payroll_wages_expense")))
    }

    fn need(id: Option<String>, category: &str) -> Result<String, PostError> {
        id.ok_or_else(|| {
            failure(format!(
                "Map an account for {category} ({}): this chart has no default for it",
                category_label(category)
            ))
        })
    }

    /// The expense (debit) account of a category.
    pub fn expense(&self, category: &str) -> Result<String, PostError> {
        let id = match category {
            "gross_wages" => self.wages()?,
            "employer_taxes" => match self.mapped(category)? {
                Some(id) => Some(id),
                None => self.role("payroll_tax_expense").or(self.wages()?),
            },
            "employer_benefits" => match self.mapped(category)? {
                Some(id) => Some(id),
                None => self.wages()?,
            },
            "reimbursements" => match self.mapped(category)? {
                Some(id) => Some(id),
                None => self.role("general_expense").or(self.wages()?),
            },
            "owners_draw" => self.mapped(category)?.or_else(|| self.role("owner_draws")),
            _ => self.mapped(category)?,
        };
        Self::need(id, category)
    }

    /// The liability (credit) account of a category.
    pub fn liability(&self, category: &str) -> Result<String, PostError> {
        let id = match self.mapped(category)? {
            Some(id) => Some(id),
            None => self
                .mapped("payroll_liabilities")?
                .or_else(|| self.role("payroll_liabilities")),
        };
        Self::need(id, category)
    }

    /// The bank or clearing account net pay goes from.
    pub fn cash(&self) -> Result<String, PostError> {
        Self::need(self.mapped("net_pay")?, "net_pay")
    }
}

/// A WeldHR pay run's totals (`WeldHrTotals`), in order.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WeldHrTotals {
    pub gross_wages: f64,
    pub employer_taxes: f64,
    pub employer_benefits: f64,
    pub reimbursements: f64,
    pub employee_taxes: f64,
    pub employee_deductions: f64,
    /// Net pay excluding reimbursements.
    pub net_pay: f64,
}

impl WeldHrTotals {
    fn named(&self) -> [(&'static str, f64); 7] {
        [
            ("grossWages", self.gross_wages),
            ("employerTaxes", self.employer_taxes),
            ("employerBenefits", self.employer_benefits),
            ("reimbursements", self.reimbursements),
            ("employeeTaxes", self.employee_taxes),
            ("employeeDeductions", self.employee_deductions),
            ("netPay", self.net_pay),
        ]
    }
}

/// `weldHrSummary(totals)`: the category record stored on the import.
pub fn weldhr_summary(totals: &WeldHrTotals) -> Value {
    let number = crate::js::number_value;
    json!({
        "gross_wages": number(totals.gross_wages),
        "employer_taxes": number(totals.employer_taxes),
        "employer_benefits": number(totals.employer_benefits),
        "reimbursements": number(totals.reimbursements),
        "employee_taxes": number(totals.employee_taxes),
        "employee_deductions": number(totals.employee_deductions),
        "net_pay": number(totals.net_pay),
    })
}

/// `resolveWeldHrMapping(accounts, country, requested)`: the requested
/// accounts, the rest from the chart's payroll roles, then the well-known
/// codes, then (net pay) the bank account.
pub fn resolve_weldhr_mapping(
    accounts: &EntityAccounts,
    us: bool,
    requested: &AccountMapping,
) -> AccountMapping {
    let mut mapping = requested.clone();
    let by_role = |role: &str| {
        accounts
            .by_role(role)
            .and_then(|a| a["id"].as_str())
            .map(str::to_owned)
    };
    let by_code = |code: &str| {
        accounts
            .by_code(code)
            .and_then(|a| a["id"].as_str())
            .map(str::to_owned)
    };
    let bank = || {
        accounts
            .by_subtype("bank")
            .and_then(|a| a["id"].as_str())
            .map(str::to_owned)
    };
    let mut fill = |category: &str, candidates: Vec<Option<String>>| {
        if mapped_id(&mapping, category).is_some() {
            return;
        }
        if let Some(id) = candidates.into_iter().flatten().find(|id| !id.is_empty()) {
            mapping.push((category.to_owned(), id));
        }
    };
    if us {
        fill("gross_wages", vec![by_role("payroll_wages_expense")]);
        fill("employer_taxes", vec![by_role("payroll_tax_expense")]);
        fill("payroll_liabilities", vec![by_role("payroll_liabilities")]);
        fill("net_pay", vec![by_code("1000"), bank()]);
    } else {
        fill(
            "gross_wages",
            vec![by_role("payroll_wages_expense"), by_code("4110")],
        );
        fill(
            "employer_taxes",
            vec![by_role("payroll_tax_expense"), by_code("4120")],
        );
        fill("employer_benefits", vec![by_code("4130")]);
        fill(
            "payroll_liabilities",
            vec![by_role("payroll_liabilities"), by_code("1800")],
        );
        fill("net_pay", vec![by_code("1100"), bank()]);
    }
    mapping
}

/// `validateWeldHrTotals(totals)`: numbers, balanced, not empty.
pub fn validate_weldhr_totals(totals: &WeldHrTotals) -> Result<(), PostError> {
    for (name, value) in totals.named() {
        if !value.is_finite() {
            return Err(failure(format!("{name} is not a number")));
        }
    }
    let gross = cents(totals.gross_wages);
    let paid_out =
        cents(totals.net_pay) + cents(totals.employee_taxes) + cents(totals.employee_deductions);
    if gross != paid_out {
        return Err(failure(format!(
            "The payroll does not balance: gross wages {} must equal net pay + employee taxes + employee deductions ({}); off by {}.",
            to_fixed(amount(gross), 2),
            to_fixed(amount(paid_out), 2),
            to_fixed(amount(gross - paid_out), 2)
        )));
    }
    if totals.named().iter().all(|(_, value)| cents(*value) == 0) {
        return Err(failure("The payroll has no amounts"));
    }
    Ok(())
}

/// `SignedBook`: lines per side and account; a negative amount lands on the
/// other side.
#[derive(Default)]
struct SignedBook {
    entries: Vec<(bool, String, i64, Vec<&'static str>)>,
}

impl SignedBook {
    fn add(
        &mut self,
        debit_side: bool,
        account_id: String,
        signed_cents: i64,
        label: &'static str,
    ) {
        if signed_cents == 0 {
            return;
        }
        let debit = if signed_cents > 0 {
            debit_side
        } else {
            !debit_side
        };
        let value = signed_cents.abs();
        match self
            .entries
            .iter_mut()
            .find(|(side, id, _, _)| *side == debit && *id == account_id)
        {
            Some(entry) => {
                entry.2 += value;
                if !entry.3.contains(&label) {
                    entry.3.push(label);
                }
            }
            None => self.entries.push((debit, account_id, value, vec![label])),
        }
    }

    fn lines(self, prefix: &str) -> Vec<PostingLine> {
        let mut lines: Vec<PostingLine> = self
            .entries
            .into_iter()
            .map(|(debit, account_id, value, labels)| PostingLine {
                account_id,
                debit: if debit { amount(value) } else { 0.0 },
                credit: if debit { 0.0 } else { amount(value) },
                description: Some(format!("{prefix}: {}", labels.join(", "))),
                ..PostingLine::default()
            })
            .collect();
        // Debits first; a stable sort keeps the rest in order.
        lines.sort_by_key(|line| line.debit == 0.0);
        lines
    }
}

/// `buildWeldHrLines(totals, accounts, mapping, label)`.
pub fn build_weldhr_lines(
    totals: &WeldHrTotals,
    accounts: &EntityAccounts,
    mapping: &AccountMapping,
    label: &str,
) -> Result<Vec<PostingLine>, PostError> {
    validate_weldhr_totals(totals)?;
    let resolve = Resolver::new(accounts, mapping);
    let mut book = SignedBook::default();
    // Accounts are only looked up for amounts that exist.
    for (category, value) in [
        ("gross_wages", totals.gross_wages),
        ("employer_taxes", totals.employer_taxes),
        ("employer_benefits", totals.employer_benefits),
        ("reimbursements", totals.reimbursements),
    ] {
        if cents(value) != 0 {
            book.add(
                true,
                resolve.expense(category)?,
                cents(value),
                category_label(category),
            );
        }
    }
    for (category, liability, value) in [
        ("employee_taxes", "employee_taxes", totals.employee_taxes),
        (
            "employee_deductions",
            "employee_deductions",
            totals.employee_deductions,
        ),
        (
            "employer_taxes",
            "payroll_liabilities",
            totals.employer_taxes,
        ),
        (
            "employer_benefits",
            "payroll_liabilities",
            totals.employer_benefits,
        ),
    ] {
        if cents(value) != 0 {
            book.add(
                false,
                resolve.liability(liability)?,
                cents(value),
                category_label(category),
            );
        }
    }
    let cash = cents(totals.net_pay) + cents(totals.reimbursements);
    if cash != 0 {
        book.add(false, resolve.cash()?, cash, category_label("net_pay"));
    }
    Ok(book.lines(label))
}

/// Why [`post_payroll_import`] did not post.
#[derive(Debug)]
pub enum PayrollError {
    /// `DuplicatePayrollError`: (entity, source, external id) was imported before.
    Duplicate {
        id: String,
        status: String,
    },
    Post(PostError),
}

impl From<PostError> for PayrollError {
    fn from(error: PostError) -> Self {
        Self::Post(error)
    }
}

impl From<sqlx::Error> for PayrollError {
    fn from(error: sqlx::Error) -> Self {
        Self::Post(PostError::Database(error))
    }
}

/// `PostPayrollArgs`.
#[derive(Debug, Clone, Default)]
pub struct PostPayrollArgs {
    pub entity_id: String,
    pub user_id: Option<String>,
    /// `csv`, `gusto` or `weldhr`.
    pub source: String,
    pub connection_id: Option<String>,
    pub external_id: String,
    /// `YYYY-MM-DD`.
    pub pay_date: String,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub lines: Vec<PostingLine>,
    pub summary: Value,
    pub source_file_name: Option<String>,
    pub description: String,
    pub reference: Option<String>,
}

/// `PostedPayroll`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostedPayroll {
    pub import_id: String,
    pub journal_entry_id: String,
    pub entry_number: Option<String>,
    pub pay_date: String,
}

/// `findImportByExternalId(db, entityId, source, externalId)`.
pub async fn find_import_by_external_id(
    db: &PgPool,
    entity_id: &str,
    source: &str,
    external_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(payroll_imports),
        " from payroll_imports t where t.entity_id = $1 and t.source = $2 and t.external_id = $3 limit 1"
    ))
    .bind(entity_id)
    .bind(source)
    .bind(external_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| PAYROLL_IMPORTS.js(row)))
}

fn duplicate_of(row: &Value) -> PayrollError {
    PayrollError::Duplicate {
        id: row["id"].as_str().unwrap_or_default().to_owned(),
        status: row["status"].as_str().unwrap_or_default().to_owned(),
    }
}

fn is_unique_violation(error: &PostError) -> bool {
    matches!(error, PostError::Database(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505"))
}

/// `postPayrollImport(db, args)`: the entry and the import row, once.
pub async fn post_payroll_import(
    db: &PgPool,
    args: PostPayrollArgs,
) -> Result<PostedPayroll, PayrollError> {
    if let Some(existing) =
        find_import_by_external_id(db, &args.entity_id, &args.source, &args.external_id).await?
    {
        return Err(duplicate_of(&existing));
    }
    let import_id = generate_id("pri");
    let at = now();
    let opt = |v: &Option<String>| v.as_ref().map_or(Value::Null, |v| json!(v));
    let mut row = Map::new();
    for (key, value) in [
        ("id", json!(import_id)),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
        ("entityId", json!(args.entity_id)),
        ("source", json!(args.source)),
        ("connectionId", opt(&args.connection_id)),
        ("externalId", json!(args.external_id)),
        ("periodStart", opt(&args.period_start)),
        ("periodEnd", opt(&args.period_end)),
        ("payDate", json!(args.pay_date)),
        ("summary", args.summary.clone()),
        ("status", json!("posted")),
        ("journalEntryId", Value::Null),
        ("sourceFileName", opt(&args.source_file_name)),
        ("createdBy", opt(&args.user_id)),
    ] {
        row.insert(key.to_owned(), value);
    }
    let write: AlsoWrite = Box::new(move |conn, posted| {
        Box::pin(async move {
            row.insert("journalEntryId".to_owned(), json!(posted.journal_entry_id));
            PAYROLL_IMPORTS
                .insert_raw(&mut *conn, PAYROLL_IMPORTS.values(&row))
                .await?;
            Ok(())
        })
    });
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: args.entity_id.clone(),
            date: format!("{}T00:00:00.000Z", args.pay_date),
            description: args.description.clone(),
            reference: args.reference.clone(),
            source_type: "payroll".to_owned(),
            source_id: Some(import_id.clone()),
            posting_key: Some(format!("payroll:{import_id}")),
            lock_kind: Some(PostingLockKind::General),
            created_by: args.user_id.clone(),
            is_automatic: Some(args.source != "csv"),
            lines: args.lines,
            also_write: vec![write],
            ..PostJournalEntryInput::default()
        },
    )
    .await;
    let posted = match posted {
        Ok(posted) => posted,
        Err(error) if is_unique_violation(&error) => {
            if let Some(raced) =
                find_import_by_external_id(db, &args.entity_id, &args.source, &args.external_id)
                    .await?
            {
                return Err(duplicate_of(&raced));
            }
            return Err(error.into());
        }
        Err(error) => return Err(error.into()),
    };
    let Some(journal_entry_id) = posted.journal_entry_id else {
        return Err(failure("The payroll has no amounts to post").into());
    };
    Ok(PostedPayroll {
        import_id,
        journal_entry_id,
        entry_number: posted.entry_number,
        pay_date: args.pay_date,
    })
}

/// `reversePayrollImport(db, args)`: reverse an import's entry, dated `date`
/// (default the pay date, so it nets in the same period). The import as it
/// is now.
pub async fn reverse_payroll_import(
    db: &PgPool,
    import_id: &str,
    user_id: Option<String>,
    date: Option<String>,
) -> Result<Value, PostError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(payroll_imports),
        " from payroll_imports t where t.id = $1 limit 1"
    ))
    .bind(import_id)
    .fetch_optional(db)
    .await?;
    let Some(mut row) = row.map(|row| PAYROLL_IMPORTS.js(row)) else {
        return Err(failure("Payroll import not found"));
    };
    if row["status"].as_str() == Some("reversed") {
        return Err(failure("This payroll import has already been reversed"));
    }
    let Some(entry_id) = row["journalEntryId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
    else {
        return Err(failure(
            "This payroll import has no journal entry to reverse",
        ));
    };
    let pay_date = row["payDate"].as_str().unwrap_or_default().to_owned();
    let date = date.unwrap_or_else(|| pay_date.clone());
    let id = import_id.to_owned();
    let write: AlsoWrite = Box::new(move |conn, _posted| {
        Box::pin(async move {
            sqlx::query("update payroll_imports set status = 'reversed', updated_at = $1::timestamp where id = $2")
                .bind(now())
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            Ok(())
        })
    });
    reverse_journal_entry(
        db,
        ReverseArgs {
            entry_id,
            date: format!("{date}T00:00:00.000Z"),
            created_by: user_id,
            description: Some(format!("Reversal of payroll {pay_date}")),
            posting_key: Some(format!("payroll:{import_id}:reversal")),
            also_write: vec![write],
            ..ReverseArgs::default()
        },
    )
    .await?;
    if let Some(object) = row.as_object_mut() {
        object.insert("status".to_owned(), json!("reversed"));
    }
    Ok(row)
}

/// What hr-api sends when a WeldHR pay run is approved (`importSchema` of
/// `routes/payroll/internal.ts`, after validation).
#[derive(Debug, Clone, Default)]
pub struct WeldHrImport {
    pub entity_id: String,
    /// The pay run id.
    pub external_id: String,
    /// `YYYY-MM-DD`.
    pub pay_date: String,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub description: String,
    /// `country === 'US'` (else NL).
    pub us: bool,
    pub totals: WeldHrTotals,
    /// Category to account id; categories left out get the chart's defaults.
    pub mapping: AccountMapping,
    /// The member who approved the run.
    pub posted_by: Option<String>,
}

/// The internal route's answer, by status.
#[derive(Debug, Clone, PartialEq)]
pub enum WeldHrReply {
    /// 201 `{ importId, journalEntryId, entryNumber, payDate, duplicate: false }`.
    /// `event` is the `payroll_import:created` event's data (source
    /// `system`), for the caller to publish in its workspace.
    Created { body: Value, event: Value },
    /// 200: the run was posted before (`duplicate: true`).
    Duplicate(Value),
    /// 409: posted before and since reversed in WeldBooks; not posted.
    Reversed { message: String, details: Value },
    /// 404: no live accounting entity `entity_id`.
    EntityNotFound,
    /// 400: totals that don't balance, an account of another entity, a
    /// closed period or lock date.
    BadRequest(String),
}

/// `POST /internal/payroll/imports` after the tenant is resolved: post a
/// WeldHR pay run once. `audit_user` is the user the audit trail records
/// (`'system'` on the internal entrypoint). A database failure is the
/// route's 500 (`Failed to post the payroll`).
#[allow(clippy::too_many_lines)] // the internal route's steps, in its order
pub async fn post_weldhr_import(
    db: &PgPool,
    input: WeldHrImport,
    audit_user: Option<&str>,
) -> Result<WeldHrReply, sqlx::Error> {
    let entity: Option<String> =
        sqlx::query_scalar("select id from entities where id = $1 and deleted_at is null limit 1")
            .bind(&input.entity_id)
            .fetch_optional(db)
            .await?;
    if entity.is_none() {
        return Ok(WeldHrReply::EntityNotFound);
    }
    let accounts = load_entity_accounts(db, &input.entity_id).await?;
    for (category, account_id) in &input.mapping {
        if accounts.by_id(Some(account_id)).is_none() {
            return Ok(WeldHrReply::BadRequest(format!(
                "The account mapped to {category} does not belong to this accounting entity"
            )));
        }
    }
    let mapping = resolve_weldhr_mapping(&accounts, input.us, &input.mapping);
    let lines = match build_weldhr_lines(&input.totals, &accounts, &mapping, &input.description) {
        Ok(lines) => lines,
        Err(error) => return failure_reply(error),
    };
    let posted = post_payroll_import(
        db,
        PostPayrollArgs {
            entity_id: input.entity_id.clone(),
            user_id: input.posted_by.clone(),
            source: "weldhr".to_owned(),
            external_id: input.external_id.clone(),
            pay_date: input.pay_date.clone(),
            period_start: input.period_start.clone(),
            period_end: input.period_end.clone(),
            lines,
            summary: weldhr_summary(&input.totals),
            description: input.description.clone(),
            reference: Some(input.external_id.clone()),
            ..PostPayrollArgs::default()
        },
    )
    .await;
    match posted {
        Ok(posted) => {
            write_audit(
                db,
                AuditInput {
                    accounting_entity_id: Some(&input.entity_id),
                    entity_type: "payroll_import",
                    entity_id: &posted.import_id,
                    action: "created",
                    changes: None,
                },
                audit_user,
                None,
            )
            .await;
            Ok(WeldHrReply::Created {
                body: json!({
                    "importId": posted.import_id,
                    "journalEntryId": posted.journal_entry_id,
                    "entryNumber": posted.entry_number,
                    "payDate": posted.pay_date,
                    "duplicate": false,
                }),
                event: json!({
                    "id": posted.import_id,
                    "entityId": input.entity_id,
                    "source": "weldhr",
                    "payDate": input.pay_date,
                    "status": "posted",
                    "journalEntryId": posted.journal_entry_id,
                }),
            })
        }
        Err(PayrollError::Duplicate { id, status }) => {
            let existing =
                find_import_by_external_id(db, &input.entity_id, "weldhr", &input.external_id)
                    .await?;
            if status == "reversed" {
                return Ok(WeldHrReply::Reversed {
                    message: "This payroll was posted to WeldBooks and has since been reversed there. It is not posted; a reversed payroll cannot be posted again.".to_owned(),
                    details: json!({ "importId": id, "status": "reversed" }),
                });
            }
            let field = |key: &str| {
                existing
                    .as_ref()
                    .map(|e| e[key].clone())
                    .filter(|v| !v.is_null())
            };
            Ok(WeldHrReply::Duplicate(json!({
                "importId": id,
                "journalEntryId": field("journalEntryId").unwrap_or(Value::Null),
                "entryNumber": null,
                "payDate": field("payDate").unwrap_or_else(|| json!(input.pay_date)),
                "duplicate": true,
                "status": status,
            })))
        }
        Err(PayrollError::Post(error)) => failure_reply(error),
    }
}

/// `isPayrollFailure(err)` is a 400 with its message; anything else the 500.
fn failure_reply(error: PostError) -> Result<WeldHrReply, sqlx::Error> {
    match error {
        PostError::Database(error) => Err(error),
        other => Ok(WeldHrReply::BadRequest(
            other.user_message().unwrap_or_default(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_must_balance() {
        let totals = WeldHrTotals {
            gross_wages: 1000.0,
            net_pay: 700.0,
            employee_taxes: 250.0,
            ..WeldHrTotals::default()
        };
        let error = validate_weldhr_totals(&totals).expect_err("unbalanced");
        assert_eq!(
            error.user_message().as_deref(),
            Some(
                "The payroll does not balance: gross wages 1000.00 must equal net pay + employee taxes + employee deductions (950.00); off by 50.00."
            )
        );
        let empty = validate_weldhr_totals(&WeldHrTotals::default()).expect_err("empty");
        assert_eq!(
            empty.user_message().as_deref(),
            Some("The payroll has no amounts")
        );
        let balanced = WeldHrTotals {
            employee_deductions: 50.0,
            ..totals
        };
        assert!(validate_weldhr_totals(&balanced).is_ok());
    }

    #[test]
    fn a_negative_amount_posts_on_the_other_side() {
        let mut book = SignedBook::default();
        book.add(false, "acc_bank".to_owned(), -500, "Net pay");
        book.add(true, "acc_wages".to_owned(), -500, "Gross wages");
        let lines = book.lines("Run 1");
        assert!((lines[0].debit - 5.0).abs() < 1e-9);
        assert_eq!(lines[0].account_id, "acc_bank");
        assert!((lines[1].credit - 5.0).abs() < 1e-9);
        assert_eq!(lines[1].description.as_deref(), Some("Run 1: Gross wages"));
    }
}
