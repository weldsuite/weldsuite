//! The ledger every financial report reads, on accrual or cash basis
//! (`services/accounting-reports-basis.ts`).
//!
//! The journal itself is always accrual. Cash basis is computed at report
//! time from payments: documents (invoices, credit notes, bills) and
//! write-offs drop out as entries and their receivable / payable lines with
//! them; a payment recognises every other line of the documents it settles on
//! its own date, pro rata to the part of the document it covers; what a
//! payment leaves unallocated lands in "Unapplied cash payment income" /
//! "Unapplied cash bill payment expense" (virtual accounts when the chart has
//! no such role). Voided payments never happened.

use std::collections::HashMap;

use serde_json::Value;
use sqlx::PgPool;

use super::{ReportInputError, iso};
use crate::js::{locale_compare, parse_float, round_money};
use crate::posting::{EntityAccounts, account_for_role, load_entity_accounts};

/// `ReportBasis`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    Accrual,
    Cash,
}

impl Basis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accrual => "accrual",
            Self::Cash => "cash",
        }
    }
}

/// Journal source types of documents: income and expense are recognised at
/// payment on cash basis.
const DOCUMENT_SOURCE_TYPES: [&str; 4] = ["invoice", "credit_note", "bill", "bill_credit_note"];

pub const UNAPPLIED_INCOME_ACCOUNT_ID: &str = "virtual:unapplied_cash_payment_income";
pub const UNAPPLIED_EXPENSE_ACCOUNT_ID: &str = "virtual:unapplied_cash_bill_payment_expense";

/// `parseBasis(value)`: nothing (or an empty value) is no preference.
pub fn parse_basis(value: Option<&str>) -> Result<Option<Basis>, ReportInputError> {
    match value {
        None | Some("") => Ok(None),
        Some("accrual") => Ok(Some(Basis::Accrual)),
        Some("cash") => Ok(Some(Basis::Cash)),
        Some(_) => Err(ReportInputError::new(
            "basis must be 'accrual' or 'cash'",
        )),
    }
}

/// `resolveBasis(db, entity, requested)`: the requested basis, else the
/// entity's accounting method, else the workspace setting, else accrual.
pub async fn resolve_basis(
    db: &PgPool,
    accounting_method: Option<&str>,
    requested: Option<Basis>,
) -> Result<Basis, sqlx::Error> {
    if let Some(basis) = requested {
        return Ok(basis);
    }
    match accounting_method {
        Some("cash") => return Ok(Basis::Cash),
        Some("accrual") => return Ok(Basis::Accrual),
        _ => {}
    }
    let method: Option<Option<String>> = sqlx::query_scalar(
        "select accounting_method from settings where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(if method.flatten().as_deref() == Some("cash") {
        Basis::Cash
    } else {
        Basis::Accrual
    })
}

/// `LedgerAccount`.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerAccount {
    pub id: String,
    pub code: String,
    pub name: String,
    pub account_type: String,
    pub subtype: Option<String>,
    /// `debit` or `credit`.
    pub normal_side: &'static str,
    pub is_active: bool,
    pub tax_line: Option<String>,
    pub form_1099_box: Option<String>,
    /// Not a chart account: the cash-basis unapplied-payment line of a chart
    /// without the system role.
    pub virtual_account: bool,
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `toLedgerAccount(row)`.
fn to_ledger_account(row: &Value) -> LedgerAccount {
    LedgerAccount {
        id: text(row, "id").unwrap_or_default(),
        code: text(row, "code").unwrap_or_default(),
        name: text(row, "name").unwrap_or_default(),
        account_type: text(row, "type").unwrap_or_default(),
        subtype: text(row, "subtype"),
        normal_side: if row.get("normalSide").and_then(Value::as_str) == Some("credit") {
            "credit"
        } else {
            "debit"
        },
        is_active: row.get("isActive") != Some(&Value::Bool(false)),
        tax_line: text(row, "taxLine"),
        form_1099_box: text(row, "form1099Box"),
        virtual_account: false,
    }
}

/// `LedgerRange`: epoch milliseconds, both inclusive; no `from` is the
/// beginning of the books.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LedgerRange {
    pub from: Option<i64>,
    pub to: i64,
}

/// `AggregateRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct AggregateRow {
    pub account_id: String,
    pub contact_id: Option<String>,
    pub debit: f64,
    pub credit: f64,
}

/// The options of [`Ledger::aggregate`]; an empty list is no filter.
#[derive(Debug, Clone, Copy, Default)]
pub struct AggregateOptions<'a> {
    pub account_types: &'a [&'a str],
    pub account_ids: &'a [&'a str],
    pub by_contact: bool,
}

impl<'a> AggregateOptions<'a> {
    pub fn types(account_types: &'a [&'a str]) -> Self {
        Self {
            account_types,
            ..Self::default()
        }
    }
}

/// `LedgerLine`.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerLine {
    pub id: String,
    pub journal_entry_id: Option<String>,
    pub entry_number: Option<String>,
    /// Epoch milliseconds.
    pub entry_date: i64,
    pub entry_status: String,
    pub description: Option<String>,
    pub debit: f64,
    pub credit: f64,
    pub contact_id: Option<String>,
    pub source_type: Option<String>,
    /// Cash basis: the payment that recognised this line.
    pub payment_id: Option<String>,
}

/// `LedgerFilters`: only lines with that class / location.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LedgerFilters {
    pub class_id: Option<String>,
    pub location_id: Option<String>,
}

#[derive(Debug, Clone)]
struct CashEvent {
    date: i64,
    account_id: String,
    /// Debit minus credit, in the entity's base currency.
    amount: f64,
    contact_id: Option<String>,
    class_id: Option<String>,
    location_id: Option<String>,
    journal_entry_id: Option<String>,
    entry_number: Option<String>,
    payment_id: String,
    description: String,
    source_type: String,
}

/// The ledger of one entity on one basis (`Ledger`).
#[derive(Debug, Clone)]
pub struct Ledger {
    pub basis: Basis,
    pub entity_id: String,
    /// The chart, in the order the database returned it, then the virtual
    /// accounts (a `Map` in TypeScript).
    accounts: Vec<LedgerAccount>,
    index: HashMap<String, usize>,
    db: PgPool,
    filters: LedgerFilters,
    control_ids: Vec<String>,
    events: Vec<CashEvent>,
}

/// `isMoneyZero(value)`.
fn is_money_zero(value: f64) -> bool {
    value.abs() < 0.005
}

/// The receivable and payable control accounts the posting service books
/// documents against.
fn control_account_ids(accounts: &EntityAccounts) -> Vec<String> {
    [
        account_for_role(accounts, "accounts_receivable", &["1300"]),
        account_for_role(accounts, "accounts_payable", &["1600"]),
    ]
    .into_iter()
    .flatten()
    .filter_map(|account| account.get("id").and_then(Value::as_str))
    .filter(|id| !id.is_empty())
    .map(str::to_owned)
    .collect()
}

/// `createLedger(db, { entityId, basis, filters, upTo })`: `up_to` is the
/// latest instant any range will reach; cash recognition is computed up to
/// it.
pub async fn create_ledger(
    db: &PgPool,
    entity_id: &str,
    basis: Basis,
    filters: LedgerFilters,
    up_to: i64,
) -> Result<Ledger, sqlx::Error> {
    let chart = load_entity_accounts(db, entity_id).await?;
    let mut accounts: Vec<LedgerAccount> = chart.rows().iter().map(to_ledger_account).collect();

    let unapplied_income = account_for_role(&chart, "unapplied_cash_payment_income", &[])
        .and_then(|a| a.get("id").and_then(Value::as_str).map(str::to_owned));
    let unapplied_expense = account_for_role(&chart, "unapplied_cash_bill_payment_expense", &[])
        .and_then(|a| a.get("id").and_then(Value::as_str).map(str::to_owned));
    let control_ids = control_account_ids(&chart);
    let mut events = Vec::new();

    if basis == Basis::Cash {
        let entity: Option<(String, String)> =
            sqlx::query_as("select id, base_currency from entities where id = $1 limit 1")
                .bind(entity_id)
                .fetch_optional(db)
                .await?;
        let (id, base_currency) =
            entity.unwrap_or_else(|| (entity_id.to_owned(), "USD".to_owned()));
        events = load_cash_events(
            db,
            &id,
            &base_currency,
            up_to,
            &control_ids,
            unapplied_income.as_deref().unwrap_or(UNAPPLIED_INCOME_ACCOUNT_ID),
            unapplied_expense
                .as_deref()
                .unwrap_or(UNAPPLIED_EXPENSE_ACCOUNT_ID),
        )
        .await?;
        if unapplied_income.is_none() {
            accounts.push(LedgerAccount {
                id: UNAPPLIED_INCOME_ACCOUNT_ID.to_owned(),
                code: String::new(),
                name: "Unapplied cash payment income".to_owned(),
                account_type: "revenue".to_owned(),
                subtype: Some("other_income".to_owned()),
                normal_side: "credit",
                is_active: true,
                tax_line: None,
                form_1099_box: None,
                virtual_account: true,
            });
        }
        if unapplied_expense.is_none() {
            accounts.push(LedgerAccount {
                id: UNAPPLIED_EXPENSE_ACCOUNT_ID.to_owned(),
                code: String::new(),
                name: "Unapplied cash bill payment expense".to_owned(),
                account_type: "expense".to_owned(),
                subtype: Some("other_expense".to_owned()),
                normal_side: "debit",
                is_active: true,
                tax_line: None,
                form_1099_box: None,
                virtual_account: true,
            });
        }
    }

    // A `Map`: a later row with the same id replaces the earlier one in place.
    let mut index = HashMap::new();
    let mut unique: Vec<LedgerAccount> = Vec::with_capacity(accounts.len());
    for account in accounts {
        if let Some(&at) = index.get(&account.id) {
            unique[at] = account;
        } else {
            index.insert(account.id.clone(), unique.len());
            unique.push(account);
        }
    }

    Ok(Ledger {
        basis,
        entity_id: entity_id.to_owned(),
        accounts: unique,
        index,
        db: db.clone(),
        filters,
        control_ids,
        events,
    })
}

/// The entry and line conditions every journal query of a ledger shares
/// (`lineConditions(range)`): `$1` entity, `$2` to, `$3` from, `$4` class,
/// `$5` location, `$6` cash basis, `$7` the control accounts.
macro_rules! line_conditions {
    () => {
        "jl.entity_id = $1 and jl.deleted_at is null and je.deleted_at is null \
         and je.status in ('posted', 'reversed') and je.date <= $2::timestamp \
         and ($3::timestamp is null or je.date >= $3::timestamp) \
         and ($4::text is null or jl.class_id = $4) \
         and ($5::text is null or jl.location_id = $5) \
         and (not $6 or ((je.source_type is null or je.source_type not in \
         ('invoice', 'credit_note', 'bill', 'bill_credit_note', 'write_off')) \
         and (cardinality($7::text[]) = 0 or jl.account_id <> all($7::text[])) \
         and not coalesce(je.source_type in ('payment', 'payment_fx_adjustment') \
         and je.source_id in (select p.id from payments p where p.deleted_at is not null), false)))"
    };
}

const AGGREGATE_SQL: &str = concat!(
    "select jl.account_id, null::text, coalesce(sum(jl.debit::numeric), 0)::text, \
     coalesce(sum(jl.credit::numeric), 0)::text from journal_lines jl \
     inner join journal_entries je on jl.journal_entry_id = je.id \
     inner join accounts a on jl.account_id = a.id where ",
    line_conditions!(),
    " and ($8::text[] is null or a.type = any($8::text[])) \
     and ($9::text[] is null or jl.account_id = any($9::text[])) group by jl.account_id"
);

const AGGREGATE_BY_CONTACT_SQL: &str = concat!(
    "select jl.account_id, jl.contact_id, coalesce(sum(jl.debit::numeric), 0)::text, \
     coalesce(sum(jl.credit::numeric), 0)::text from journal_lines jl \
     inner join journal_entries je on jl.journal_entry_id = je.id \
     inner join accounts a on jl.account_id = a.id where ",
    line_conditions!(),
    " and ($8::text[] is null or a.type = any($8::text[])) \
     and ($9::text[] is null or jl.account_id = any($9::text[])) \
     group by jl.account_id, jl.contact_id"
);

const ACCOUNT_LINES_SQL: &str = concat!(
    "select jl.id, jl.journal_entry_id, je.entry_number, \
     floor(extract(epoch from je.date) * 1000)::bigint, je.status, jl.description, \
     jl.debit::text, jl.credit::text, jl.contact_id, je.source_type \
     from journal_lines jl inner join journal_entries je on jl.journal_entry_id = je.id where ",
    line_conditions!(),
    " and jl.account_id = $8 order by je.date asc, je.id asc, jl.sort_order asc"
);

type LineRow = (
    String,
    Option<String>,
    Option<String>,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

impl Ledger {
    /// The accounts, in the order of the TypeScript `Map`.
    pub fn accounts(&self) -> &[LedgerAccount] {
        &self.accounts
    }

    /// `accounts.get(id)`.
    pub fn account(&self, id: &str) -> Option<&LedgerAccount> {
        self.index.get(id).map(|&at| &self.accounts[at])
    }

    fn events_in(&self, range: LedgerRange) -> impl Iterator<Item = &CashEvent> {
        let from = range.from.unwrap_or(i64::MIN);
        self.events.iter().filter(move |e| {
            if e.date < from || e.date > range.to {
                return false;
            }
            if let Some(class) = &self.filters.class_id
                && e.class_id.as_ref() != Some(class)
            {
                return false;
            }
            if let Some(location) = &self.filters.location_id
                && e.location_id.as_ref() != Some(location)
            {
                return false;
            }
            true
        })
    }

    fn bind_conditions<'q, O>(
        &'q self,
        query: sqlx::query::QueryAs<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments>,
        range: LedgerRange,
    ) -> sqlx::query::QueryAs<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments> {
        query
            .bind(&self.entity_id)
            .bind(iso(range.to))
            .bind(range.from.map(iso))
            .bind(self.filters.class_id.as_deref())
            .bind(self.filters.location_id.as_deref())
            .bind(self.basis == Basis::Cash)
            .bind(&self.control_ids)
    }

    /// `aggregate(range, opts)`: debit and credit totals per account (and per
    /// contact with `by_contact`).
    pub async fn aggregate(
        &self,
        range: LedgerRange,
        opts: AggregateOptions<'_>,
    ) -> Result<Vec<AggregateRow>, sqlx::Error> {
        let types: Option<Vec<String>> = (!opts.account_types.is_empty())
            .then(|| opts.account_types.iter().map(|t| (*t).to_owned()).collect());
        let ids: Option<Vec<String>> = (!opts.account_ids.is_empty())
            .then(|| opts.account_ids.iter().map(|t| (*t).to_owned()).collect());
        let sql = if opts.by_contact {
            AGGREGATE_BY_CONTACT_SQL
        } else {
            AGGREGATE_SQL
        };
        let rows: Vec<(String, Option<String>, String, String)> = self
            .bind_conditions(sqlx::query_as(sql), range)
            .bind(types)
            .bind(ids)
            .fetch_all(&self.db)
            .await?;

        let key = |account_id: &str, contact_id: Option<&str>| {
            if opts.by_contact {
                format!("{account_id}|{}", contact_id.unwrap_or_default())
            } else {
                account_id.to_owned()
            }
        };
        let mut merged: Vec<AggregateRow> = Vec::with_capacity(rows.len());
        let mut at: HashMap<String, usize> = HashMap::new();
        for (account_id, contact_id, debit, credit) in rows {
            let row = AggregateRow {
                contact_id: if opts.by_contact { contact_id } else { None },
                debit: parse_float(&debit),
                credit: parse_float(&credit),
                account_id,
            };
            let k = key(&row.account_id, row.contact_id.as_deref());
            if let Some(&i) = at.get(&k) {
                merged[i] = row;
            } else {
                at.insert(k, merged.len());
                merged.push(row);
            }
        }

        for e in self.events_in(range) {
            let Some(account) = self.account(&e.account_id) else {
                continue;
            };
            if !opts.account_types.is_empty()
                && !opts.account_types.contains(&account.account_type.as_str())
            {
                continue;
            }
            if !opts.account_ids.is_empty() && !opts.account_ids.contains(&e.account_id.as_str()) {
                continue;
            }
            let k = key(&e.account_id, e.contact_id.as_deref());
            let i = if let Some(&i) = at.get(&k) {
                i
            } else {
                at.insert(k, merged.len());
                merged.push(AggregateRow {
                    account_id: e.account_id.clone(),
                    contact_id: if opts.by_contact {
                        e.contact_id.clone()
                    } else {
                        None
                    },
                    debit: 0.0,
                    credit: 0.0,
                });
                merged.len() - 1
            };
            let row = &mut merged[i];
            if e.amount > 0.0 {
                row.debit = round_money(row.debit + e.amount);
            } else {
                row.credit = round_money(row.credit - e.amount);
            }
        }
        Ok(merged)
    }

    /// `accountLines(accountId, range)`: every line of one account in a
    /// range, oldest first.
    pub async fn account_lines(
        &self,
        account_id: &str,
        range: LedgerRange,
    ) -> Result<Vec<LedgerLine>, sqlx::Error> {
        let mut lines = Vec::new();
        if !account_id.starts_with("virtual:") {
            let rows: Vec<LineRow> = self
                .bind_conditions(sqlx::query_as(ACCOUNT_LINES_SQL), range)
                .bind(account_id)
                .fetch_all(&self.db)
                .await?;
            for (
                id,
                journal_entry_id,
                entry_number,
                entry_date,
                entry_status,
                description,
                debit,
                credit,
                contact_id,
                source_type,
            ) in rows
            {
                lines.push(LedgerLine {
                    id,
                    journal_entry_id,
                    entry_number,
                    entry_date,
                    entry_status,
                    description,
                    debit: parse_float(debit.as_deref().unwrap_or("0")),
                    credit: parse_float(credit.as_deref().unwrap_or("0")),
                    contact_id,
                    source_type,
                    payment_id: None,
                });
            }
        }
        let recognised = self
            .events_in(range)
            .filter(|e| e.account_id == account_id)
            .enumerate()
            .map(|(i, e)| LedgerLine {
                id: format!("cash:{}:{i}", e.payment_id),
                journal_entry_id: e.journal_entry_id.clone(),
                entry_number: e.entry_number.clone(),
                entry_date: e.date,
                entry_status: "posted".to_owned(),
                description: Some(e.description.clone()),
                debit: if e.amount > 0.0 { e.amount } else { 0.0 },
                credit: if e.amount < 0.0 { -e.amount } else { 0.0 },
                contact_id: e.contact_id.clone(),
                source_type: Some(e.source_type.clone()),
                payment_id: Some(e.payment_id.clone()),
            });
        lines.extend(recognised);
        lines.sort_by_key(|line| line.entry_date);
        Ok(lines)
    }
}

// ---------------------------------------------------------------------------
// Cash recognition
// ---------------------------------------------------------------------------

struct PaymentRow {
    id: String,
    kind: String,
    amount: String,
    currency: Option<String>,
    exchange_rate: Option<String>,
    date: i64,
    contact_id: Option<String>,
    reference: Option<String>,
    invoice_id: Option<String>,
    bill_id: Option<String>,
}

#[derive(Clone)]
struct Allocation {
    payment_id: String,
    invoice_id: Option<String>,
    bill_id: Option<String>,
    amount: f64,
}

struct DocumentRow {
    total: f64,
    number: Option<String>,
}

struct DocumentLineGroup {
    account_id: String,
    contact_id: Option<String>,
    class_id: Option<String>,
    location_id: Option<String>,
    /// Debit minus credit of the accrual entry.
    net: f64,
}

struct DocumentEntry {
    journal_entry_id: String,
    entry_number: Option<String>,
    source_type: String,
    groups: Vec<DocumentLineGroup>,
}

/// An insertion-ordered map (JavaScript's `Map`).
struct Ordered<V> {
    keys: Vec<String>,
    values: HashMap<String, V>,
}

impl<V> Ordered<V> {
    fn new() -> Self {
        Self {
            keys: Vec::new(),
            values: HashMap::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.values.get(key)
    }

    fn contains(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    fn entry(&mut self, key: &str, make: impl FnOnce() -> V) -> &mut V {
        if !self.values.contains_key(key) {
            self.keys.push(key.to_owned());
        }
        self.values.entry(key.to_owned()).or_insert_with(make)
    }

    fn set(&mut self, key: &str, value: V) {
        if !self.values.contains_key(key) {
            self.keys.push(key.to_owned());
        }
        self.values.insert(key.to_owned(), value);
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.keys
            .iter()
            .filter_map(|key| self.values.get(key).map(|value| (key, value)))
    }
}

/// `baseConverter(baseCurrency, currency, exchangeRate)`.
fn base_converter(
    base_currency: &str,
    currency: Option<&str>,
    exchange_rate: Option<&str>,
) -> impl Fn(f64) -> f64 {
    let rate = parse_float(exchange_rate.unwrap_or("1"));
    let same_currency = currency.is_none_or(|c| c.is_empty() || c == base_currency);
    move |amount| {
        if same_currency || !rate.is_finite() || rate == 0.0 {
            round_money(amount)
        } else {
            crate::currency::to_base_currency(amount, rate)
        }
    }
}

type PaymentTuple = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

type GroupTuple = (
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// `loadCashEvents(db, entity, upTo, controlIds, unappliedIncomeId, unappliedExpenseId)`.
#[allow(clippy::too_many_lines)] // mirrors the TypeScript function step for step
async fn load_cash_events(
    db: &PgPool,
    entity_id: &str,
    base_currency: &str,
    up_to: i64,
    control_ids: &[String],
    unapplied_income_id: &str,
    unapplied_expense_id: &str,
) -> Result<Vec<CashEvent>, sqlx::Error> {
    let up_to = iso(up_to);
    let payment_rows: Vec<PaymentTuple> = sqlx::query_as(
        "select id, type, amount::text, currency, exchange_rate::text, \
         floor(extract(epoch from date) * 1000)::bigint, contact_id, reference, invoice_id, bill_id \
         from payments where entity_id = $1 and deleted_at is null and date <= $2::timestamp",
    )
    .bind(entity_id)
    .bind(&up_to)
    .fetch_all(db)
    .await?;
    if payment_rows.is_empty() {
        return Ok(Vec::new());
    }
    let payment_rows: Vec<PaymentRow> = payment_rows
        .into_iter()
        .map(
            |(
                id,
                kind,
                amount,
                currency,
                exchange_rate,
                date,
                contact_id,
                reference,
                invoice_id,
                bill_id,
            )| PaymentRow {
                id,
                kind,
                amount,
                currency,
                exchange_rate,
                date,
                contact_id,
                reference,
                invoice_id,
                bill_id,
            },
        )
        .collect();

    let allocation_rows: Vec<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "select pa.payment_id, pa.invoice_id, pa.bill_id, pa.amount::text \
         from payment_allocations pa inner join payments p on pa.payment_id = p.id \
         where p.entity_id = $1 and p.deleted_at is null and pa.deleted_at is null \
         and p.date <= $2::timestamp",
    )
    .bind(entity_id)
    .bind(&up_to)
    .fetch_all(db)
    .await?;

    let mut allocations_by_payment: Ordered<Vec<Allocation>> = Ordered::new();
    for (payment_id, invoice_id, bill_id, amount) in allocation_rows {
        allocations_by_payment
            .entry(&payment_id, Vec::new)
            .push(Allocation {
                payment_id: payment_id.clone(),
                invoice_id,
                bill_id,
                amount: parse_float(&amount),
            });
    }
    // Payments recorded before allocations existed settle one document with
    // their full amount.
    for p in &payment_rows {
        if allocations_by_payment.contains(&p.id) {
            continue;
        }
        if p.invoice_id.is_some() || p.bill_id.is_some() {
            allocations_by_payment.set(
                &p.id,
                vec![Allocation {
                    payment_id: p.id.clone(),
                    invoice_id: p.invoice_id.clone(),
                    bill_id: p.bill_id.clone(),
                    amount: parse_float(&p.amount),
                }],
            );
        }
    }

    let mut invoice_ids: Vec<String> = Vec::new();
    let mut bill_ids: Vec<String> = Vec::new();
    for (_, list) in allocations_by_payment.iter() {
        for a in list {
            if let Some(id) = a.invoice_id.as_ref().filter(|id| !id.is_empty())
                && !invoice_ids.contains(id)
            {
                invoice_ids.push(id.clone());
            }
            if let Some(id) = a.bill_id.as_ref().filter(|id| !id.is_empty())
                && !bill_ids.contains(id)
            {
                bill_ids.push(id.clone());
            }
        }
    }

    let mut documents: Ordered<DocumentRow> = Ordered::new();
    for ids in invoice_ids.chunks(400) {
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, total::text, invoice_number from invoices \
             where entity_id = $1 and id = any($2::text[])",
        )
        .bind(entity_id)
        .bind(ids)
        .fetch_all(db)
        .await?;
        for (id, total, number) in rows {
            documents.set(
                &id,
                DocumentRow {
                    total: parse_float(total.as_deref().unwrap_or("0")),
                    number,
                },
            );
        }
    }
    for ids in bill_ids.chunks(400) {
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, total::text, bill_number from bills \
             where entity_id = $1 and id = any($2::text[])",
        )
        .bind(entity_id)
        .bind(ids)
        .fetch_all(db)
        .await?;
        for (id, total, number) in rows {
            documents.set(
                &id,
                DocumentRow {
                    total: parse_float(total.as_deref().unwrap_or("0")),
                    number,
                },
            );
        }
    }

    // The accrual entry of every document that has a payment.
    let mut document_entries: Ordered<DocumentEntry> = Ordered::new();
    let document_ids: Vec<String> = documents.keys.clone();
    for ids in document_ids.chunks(400) {
        let rows: Vec<GroupTuple> = sqlx::query_as(
            "select je.source_id, je.source_type, je.id, je.entry_number, jl.account_id, \
             jl.contact_id, jl.class_id, jl.location_id, \
             coalesce(sum(jl.debit::numeric - jl.credit::numeric), 0)::text \
             from journal_lines jl inner join journal_entries je on jl.journal_entry_id = je.id \
             where je.entity_id = $1 and je.deleted_at is null and je.reversal_of_id is null \
             and je.status in ('posted', 'reversed') \
             and je.source_type in ('invoice', 'credit_note', 'bill', 'bill_credit_note') \
             and je.source_id = any($2::text[]) and jl.deleted_at is null \
             group by je.source_id, je.source_type, je.id, je.entry_number, jl.account_id, \
             jl.contact_id, jl.class_id, jl.location_id",
        )
        .bind(entity_id)
        .bind(ids)
        .fetch_all(db)
        .await?;
        for (
            source_id,
            source_type,
            journal_entry_id,
            entry_number,
            account_id,
            contact_id,
            class_id,
            location_id,
            net,
        ) in rows
        {
            let Some(source_id) = source_id.filter(|id| !id.is_empty()) else {
                continue;
            };
            if control_ids.contains(&account_id) {
                continue;
            }
            let entry = document_entries.entry(&source_id, || DocumentEntry {
                journal_entry_id,
                entry_number,
                source_type: source_type.unwrap_or_default(),
                groups: Vec::new(),
            });
            entry.groups.push(DocumentLineGroup {
                account_id,
                contact_id,
                class_id,
                location_id,
                net: round_money(parse_float(&net)),
            });
        }
    }
    debug_assert!(DOCUMENT_SOURCE_TYPES.len() == 4);

    let payment_by_id: HashMap<&str, &PaymentRow> =
        payment_rows.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut events: Vec<CashEvent> = Vec::new();

    // Allocations per document, oldest payment first, so cumulative rounding
    // is stable.
    let mut allocations_by_document: Ordered<Vec<Allocation>> = Ordered::new();
    for (_, list) in allocations_by_payment.iter() {
        for a in list {
            let Some(document_id) = a.invoice_id.clone().or_else(|| a.bill_id.clone()) else {
                continue;
            };
            if document_id.is_empty() {
                continue;
            }
            allocations_by_document
                .entry(&document_id, Vec::new)
                .push(a.clone());
        }
    }

    for (document_id, list) in allocations_by_document.iter() {
        let (Some(document), Some(entry)) = (
            documents.get(document_id),
            document_entries.get(document_id),
        ) else {
            continue;
        };
        if document.total <= 0.0 || document.total.is_nan() || entry.groups.is_empty() {
            continue;
        }
        let mut sorted: Vec<&Allocation> = list.iter().collect();
        sorted.sort_by(|a, b| {
            let (pa, pb) = (payment_by_id.get(a.payment_id.as_str()), payment_by_id.get(b.payment_id.as_str()));
            match (pa, pb) {
                (Some(pa), Some(pb)) => pa
                    .date
                    .cmp(&pb.date)
                    .then_with(|| locale_compare(&pa.id, &pb.id)),
                _ => std::cmp::Ordering::Equal,
            }
        });

        let sum = round_money(entry.groups.iter().fold(0.0, |total, g| total + g.net));
        // The group that absorbs rounding, so the lines always add up to the
        // share of the whole.
        let largest = entry
            .groups
            .iter()
            .enumerate()
            .fold(0, |best, (i, g)| {
                if g.net.abs() > entry.groups[best].net.abs() {
                    i
                } else {
                    best
                }
            });
        let mut paid = 0.0_f64;
        let mut previous: Vec<f64> = vec![0.0; entry.groups.len()];

        for allocation in sorted {
            let Some(payment) = payment_by_id.get(allocation.payment_id.as_str()) else {
                continue;
            };
            paid = document.total.min(round_money(paid + allocation.amount));
            let share = paid / document.total;
            let mut recognised: Vec<f64> = entry
                .groups
                .iter()
                .map(|g| round_money(g.net * share))
                .collect();
            let total: f64 = recognised.iter().fold(0.0, |t, v| t + v);
            recognised[largest] =
                round_money(recognised[largest] + round_money(sum * share) - total);

            for (i, group) in entry.groups.iter().enumerate() {
                let delta = round_money(recognised[i] - previous[i]);
                if is_money_zero(delta) {
                    continue;
                }
                let number = document.number.clone().unwrap_or_else(|| document_id.clone());
                let reference = payment
                    .reference
                    .as_deref()
                    .filter(|r| !r.is_empty())
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default();
                events.push(CashEvent {
                    date: payment.date,
                    account_id: group.account_id.clone(),
                    amount: delta,
                    contact_id: group.contact_id.clone(),
                    class_id: group.class_id.clone(),
                    location_id: group.location_id.clone(),
                    journal_entry_id: Some(entry.journal_entry_id.clone()),
                    entry_number: entry.entry_number.clone(),
                    payment_id: payment.id.clone(),
                    description: format!("{number} paid{reference}"),
                    source_type: entry.source_type.clone(),
                });
            }
            previous = recognised;
        }
    }

    // The part of a payment no document claims.
    for payment in &payment_rows {
        let allocations: &[Allocation] = allocations_by_payment
            .get(&payment.id)
            .map_or(&[], Vec::as_slice);
        let allocated = allocations.iter().fold(0.0, |total, a| total + a.amount);
        let amount = parse_float(&payment.amount);
        let unapplied = round_money(amount - allocated);
        if unapplied <= 0.004 || unapplied.is_nan() {
            continue;
        }
        let to_base = base_converter(
            base_currency,
            payment.currency.as_deref(),
            payment.exchange_rate.as_deref(),
        );
        let base_total = to_base(amount);
        let base_allocated = allocations
            .iter()
            .fold(0.0, |total, a| round_money(total + to_base(a.amount)));
        let base = round_money(base_total - base_allocated);
        if is_money_zero(base) {
            continue;
        }
        let received = payment.kind == "received";
        let reference = payment
            .reference
            .as_deref()
            .filter(|r| !r.is_empty())
            .map(|r| format!(" {r}"))
            .unwrap_or_default();
        events.push(CashEvent {
            date: payment.date,
            account_id: if received {
                unapplied_income_id
            } else {
                unapplied_expense_id
            }
            .to_owned(),
            amount: if received { -base } else { base },
            contact_id: payment.contact_id.clone(),
            class_id: None,
            location_id: None,
            journal_entry_id: None,
            entry_number: None,
            payment_id: payment.id.clone(),
            description: format!(
                "Unapplied {}{reference}",
                if received {
                    "payment received"
                } else {
                    "payment sent"
                }
            ),
            source_type: "unapplied_payment".to_owned(),
        });
    }

    Ok(events)
}
