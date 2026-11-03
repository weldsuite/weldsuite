//! Ledger postings for documents (books-api
//! `services/accounting-document-posting.ts`): which accounts an invoice,
//! credit note, bill, payment or write-off debits and credits, and which
//! tax-ledger rows it writes. Everything goes through
//! [`post_journal_entry`], so every document posts atomically and at most
//! once.
//!
//! ```text
//! invoice       Dr receivable (total) / Cr revenue per line account, Cr tax per rate
//! US invoice    the same, with Cr tax per agency and one tax-ledger row per jurisdiction and line
//! credit note   the invoice entry mirrored (US: negative tax-ledger rows)
//! bill          Dr expense per line, Dr deductible input tax / Cr payable (total)
//!               self-assessed tax: Dr input tax / Cr tax payable; non-deductible tax (KOR) is cost
//! US bill       supplier tax is cost; use tax: Dr the line's account / Cr Use Tax Payable - <agency>
//! payment in    Dr bank / Cr receivable per allocation; payment out the other way round
//! write-off     Dr bad debts / Cr receivable (US: the tax share back off the agency's payable)
//! ```
//!
//! Rows are `serde_json::Value`s as Drizzle returns them ([`crate::table::Table::js`]).

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::{PgConnection, PgPool};
use weldsuite_ports::OutboundHttp;

use crate::currency::to_base_currency;
use crate::fx::{parse_rate, require_booking_rate};
use crate::guards::{PostingLockKind, is_kor_active};
use crate::http::now;
use crate::js::{
    js_number_value, math_round, millis_of, number_value, parse_float, round_money, to_fixed,
};
use crate::jurisdictions::{adapter, has_adapter, js_trim};
use crate::posting::{
    AlsoWrite, EntityAccounts, PostError, PostJournalEntryInput, PostedEntry, PostingLine,
    PostingTaxLine, account_for_role, load_entity_accounts, post_journal_entry,
};
use crate::sales_tax::{
    TaxLineFieldsContext, allocate_cents, breakdown_to_tax_line_fields, from_cents, pick_ship_to,
    round_half_up, to_cents, zip5_of,
};
use crate::tables::{BILLS, ENTITIES, INVOICES, TAX_RATES};

/// Legacy fallbacks for entities seeded before a role existed (NL / IN
/// template codes): `FALLBACK_CODES`.
pub mod fallback {
    pub const ACCOUNTS_RECEIVABLE: &[&str] = &["1300"];
    pub const ACCOUNTS_PAYABLE: &[&str] = &["1600"];
    pub const SALES_REVENUE: &[&str] = &["8000"];
    pub const TAX_PAYABLE: &[&str] = &["1700"];
    pub const TAX_INPUT: &[&str] = &["1730"];
    pub const GENERAL_EXPENSE: &[&str] = &["4600"];
}

fn posting(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

// ── row access ──────────────────────────────────────────────────────────────

/// `row.key` when it is a string (empty included).
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `row.key` when it is a non-empty string (truthy).
pub(crate) fn filled<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text(row, key).filter(|t| !t.is_empty())
}

pub(crate) fn owned(row: &Value, key: &str) -> Option<String> {
    text(row, key).map(str::to_owned)
}

/// `Number(row.key)`.
pub(crate) fn number(row: &Value, key: &str) -> f64 {
    js_number_value(row.get(key))
}

/// `Number.parseFloat(row.key ?? '0')` of a numeric column.
pub(crate) fn amount_of(row: &Value, key: &str) -> f64 {
    match row.get(key) {
        Some(Value::String(t)) => parse_float(t),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => 0.0,
    }
}

/// `row.key ?? false` / a truthy flag.
fn flag(row: &Value, key: &str) -> bool {
    crate::js::truthy(row.get(key))
}

/// `` `${a} ${b ?? ''}`.trim() ``.
pub(crate) fn label(prefix: &str, number: Option<&str>) -> String {
    js_trim(&format!("{prefix} {}", number.unwrap_or_default())).to_owned()
}

fn id_of(account: &Value) -> String {
    account["id"].as_str().unwrap_or_default().to_owned()
}

/// A document's `taxBreakdown` rows (`?? []`).
pub fn breakdown_of(document: &Value) -> Vec<Value> {
    document
        .get("taxBreakdown")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The document date as milliseconds (`invoice.issueDate`).
fn millis(document: &Value, key: &str) -> i64 {
    text(document, key).and_then(millis_of).unwrap_or(0)
}

// ── shared lookups ──────────────────────────────────────────────────────────

/// `loadEntity(db, entityId)`: a live entity, else a posting error.
pub async fn load_entity(db: &PgPool, entity_id: &str) -> Result<Value, PostError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| ENTITIES.js(row))
        .ok_or_else(|| posting("Accounting entity not found"))
}

/// `loadTaxRates(db, entityId, ids)`: the entity's rates by id.
pub async fn load_tax_rates<'a>(
    db: &PgPool,
    entity_id: &str,
    ids: impl IntoIterator<Item = Option<&'a str>>,
) -> Result<HashMap<String, Value>, sqlx::Error> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids.into_iter().flatten() {
        if !id.is_empty() && !unique.iter().any(|u| u == id) {
            unique.push(id.to_owned());
        }
    }
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(tax_rates),
        " from tax_rates t where t.entity_id = $1 and t.id = any($2)"
    ))
    .bind(entity_id)
    .bind(&unique)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let row = TAX_RATES.js(row);
            (id_of(&row), row)
        })
        .collect())
}

/// `rates.get(row.taxRateId)`.
fn rate_for<'a>(rates: &'a HashMap<String, Value>, row: &Value) -> Option<&'a Value> {
    text(row, "taxRateId").and_then(|id| rates.get(id))
}

/// A party's default revenue and expense accounts (`loadParty`).
async fn load_party(
    db: &PgPool,
    party_id: Option<&str>,
) -> Result<(Option<String>, Option<String>), sqlx::Error> {
    let Some(party_id) = party_id.filter(|id| !id.is_empty()) else {
        return Ok((None, None));
    };
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select default_revenue_account_id, default_expense_account_id from parties where id = $1 limit 1",
    )
    .bind(party_id)
    .fetch_optional(db)
    .await?;
    Ok(row.unwrap_or_default())
}

/// `baseConverter(...)`: document-currency amounts to the entity's base
/// currency (`rate`: foreign units per base unit).
#[derive(Debug, Clone, Copy)]
pub struct ToBase(Option<f64>);

impl ToBase {
    pub fn apply(self, amount: f64) -> f64 {
        match self.0 {
            None => round_money(amount),
            Some(rate) => to_base_currency(amount, rate),
        }
    }
}

/// `baseConverter(entity, currency, exchangeRate)`: a foreign document
/// without a usable rate is an error, amounts never carry over 1:1.
pub fn base_converter(
    entity: &Value,
    currency: Option<&str>,
    exchange_rate: &Value,
) -> Result<ToBase, PostError> {
    let base = entity.get("baseCurrency").and_then(Value::as_str);
    let Some(currency) = currency.filter(|c| !c.is_empty() && Some(*c) != base) else {
        return Ok(ToBase(None));
    };
    match parse_rate(exchange_rate) {
        Some(rate) => Ok(ToBase(Some(rate))),
        None => Err(posting(format!(
            "The exchange rate for {currency} against {} is missing. Enter an exchange rate or add one under FX rates.",
            base.unwrap_or("null")
        ))),
    }
}

/// `requireAccount(account, message)`.
pub fn require_account(account: Option<&Value>, message: &str) -> Result<String, PostError> {
    account.map(id_of).ok_or_else(|| posting(message))
}

/// `taxAccountFor(accounts, row, rate, direction)`: the component's role
/// (India), the rate's ledger account, else the role for the direction.
pub fn tax_account_for(
    accounts: &EntityAccounts,
    row: &Value,
    rate: Option<&Value>,
    purchase: bool,
) -> Result<String, PostError> {
    if let Some(component) = filled(row, "accountRole").and_then(|role| accounts.by_role(role)) {
        return Ok(id_of(component));
    }
    if let Some(ledger) = accounts.by_id(rate.and_then(|r| text(r, "ledgerAccountId"))) {
        return Ok(id_of(ledger));
    }
    // The US chart has no tax_payable / tax_input roles, only sales and use tax payable.
    let by_direction = if purchase {
        account_for_role(accounts, "tax_input", fallback::TAX_INPUT)
            .or_else(|| account_for_role(accounts, "tax_payable", fallback::TAX_PAYABLE))
            .or_else(|| account_for_role(accounts, "sales_tax_payable", &[]))
    } else {
        account_for_role(accounts, "tax_payable", fallback::TAX_PAYABLE)
            .or_else(|| account_for_role(accounts, "sales_tax_payable", &[]))
    };
    require_account(
        by_direction,
        "No tax account found. Link the tax rate to a ledger account or add a tax payable account.",
    )
}

/// `roleAccount(accounts, role, what)`: the account holding a system role
/// (BR tax rows name theirs); a missing one is a setup error.
fn role_account(
    accounts: &EntityAccounts,
    role: Option<&str>,
    what: &str,
) -> Result<String, PostError> {
    require_account(
        role.filter(|r| !r.is_empty())
            .and_then(|r| accounts.by_role(r)),
        &format!(
            "No account with the role {} for \"{what}\". Add it to the chart of accounts.",
            role.unwrap_or("(none)")
        ),
    )
}

/// How a document's tax rows convert and whom they are about.
#[derive(Debug, Clone)]
pub struct TaxArgs<'a> {
    pub purchase: bool,
    pub sign: f64,
    pub currency: &'a str,
    pub to_base: ToBase,
    pub contact_id: Option<&'a str>,
}

/// `breakdownToTaxLine(row, rate, args)`.
pub fn breakdown_to_tax_line(
    row: &Value,
    rate: Option<&Value>,
    args: &TaxArgs<'_>,
) -> PostingTaxLine {
    let taxable = number(row, "taxableAmount") * args.sign;
    let tax = number(row, "taxAmount") * args.sign;
    let nullish = |key: &str| row.get(key).filter(|v| !v.is_null());
    PostingTaxLine {
        direction: if args.purchase { "purchase" } else { "sales" }.to_owned(),
        tax_rate_id: filled(row, "taxRateId").map(str::to_owned),
        tax_rate_name: nullish("taxRateName")
            .and_then(Value::as_str)
            .or_else(|| rate.and_then(|r| text(r, "name")))
            .map(str::to_owned),
        tax_category_code: nullish("taxCategoryCode")
            .and_then(Value::as_str)
            .or_else(|| rate.and_then(|r| text(r, "taxCategoryCode")))
            .map(str::to_owned),
        rate: number(row, "taxRate"),
        component: owned(row, "component"),
        self_assessed: flag(row, "selfAssessed"),
        taxable_amount: taxable,
        tax_amount: tax,
        currency: args.currency.to_owned(),
        base_taxable_amount: args.to_base.apply(taxable),
        base_tax_amount: args.to_base.apply(tax),
        contact_id: args.contact_id.map(str::to_owned),
        ..PostingTaxLine::default()
    }
}

// ── US sales tax: agencies, accounts, tax-ledger rows ──────────────────────

struct Agency {
    name: Option<String>,
    liability_account_id: Option<String>,
    use_tax_account_id: Option<String>,
}

/// `id, name, liability_account_id, use_tax_account_id`.
type AgencyRow = (String, Option<String>, Option<String>, Option<String>);

async fn load_agency_accounts(
    db: &PgPool,
    entity_id: &str,
) -> Result<HashMap<String, Agency>, sqlx::Error> {
    let rows: Vec<AgencyRow> = sqlx::query_as(
        "select id, name, liability_account_id, use_tax_account_id from sales_tax_agencies where entity_id = $1",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, liability_account_id, use_tax_account_id)| {
            (
                id,
                Agency {
                    name,
                    liability_account_id,
                    use_tax_account_id,
                },
            )
        })
        .collect())
}

/// The agency's Sales Tax Payable child account, else the Sales Tax Payable
/// role account (a row with no agency: unregistered, marketplace).
fn sales_tax_account_for(
    accounts: &EntityAccounts,
    agencies: &HashMap<String, Agency>,
    agency_id: Option<&str>,
) -> Result<String, PostError> {
    let own = agency_id.filter(|id| !id.is_empty()).and_then(|id| {
        accounts.by_id(
            agencies
                .get(id)
                .and_then(|a| a.liability_account_id.as_deref()),
        )
    });
    if let Some(own) = own {
        return Ok(id_of(own));
    }
    require_account(
        account_for_role(accounts, "sales_tax_payable", &["2200"]),
        "No Sales Tax Payable account found. Add the agency in the sales tax settings first.",
    )
}

fn use_tax_account_for(
    accounts: &EntityAccounts,
    agencies: &HashMap<String, Agency>,
    agency_id: Option<&str>,
) -> Result<String, PostError> {
    let own = agency_id.filter(|id| !id.is_empty()).and_then(|id| {
        accounts.by_id(
            agencies
                .get(id)
                .and_then(|a| a.use_tax_account_id.as_deref()),
        )
    });
    if let Some(own) = own {
        return Ok(id_of(own));
    }
    require_account(
        account_for_role(accounts, "use_tax_payable", &["2210"]),
        "No Use Tax Payable account found for this entity.",
    )
}

/// What `usTaxLines` stamps on every row besides the amounts.
#[derive(Debug, Clone, Default)]
pub struct UsTaxContext {
    pub sign: f64,
    /// `sales` or `use`.
    pub direction: &'static str,
    pub currency: String,
    pub contact_id: Option<String>,
    pub marketplace_facilitated: bool,
    pub ship_to_state: Option<String>,
    pub ship_to_postal_code: Option<String>,
    pub engine: Option<String>,
    pub engine_ref: Option<String>,
}

/// `usTaxLines(rows, args)`: one tax-ledger row per jurisdiction and line,
/// zero-tax ones included. `sign` -1 writes a credit memo's rows negative.
pub fn us_tax_lines(rows: &[Value], ctx: &UsTaxContext, to_base: ToBase) -> Vec<PostingTaxLine> {
    let fields = breakdown_to_tax_line_fields(
        rows,
        &TaxLineFieldsContext {
            sign: ctx.sign,
            direction: Some(ctx.direction.to_owned()),
            marketplace_facilitated: ctx.marketplace_facilitated,
            ship_to_state: ctx.ship_to_state.clone(),
            ship_to_postal_code: ctx.ship_to_postal_code.clone(),
            engine: ctx.engine.clone(),
            engine_ref: ctx.engine_ref.clone(),
        },
    );
    rows.iter()
        .zip(fields)
        .map(|(row, f)| {
            let taxable = number(row, "taxableAmount") * ctx.sign;
            let tax = number(row, "taxAmount") * ctx.sign;
            let field = |key: &str| {
                f.get(key)
                    .filter(|v| !v.is_null())
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            let mut extra = Map::new();
            for key in [
                "agencyId",
                "jurisdictionName",
                "reportingCode",
                "grossAmount",
                "exemptAmount",
                "nonTaxableAmount",
                "exemptReason",
                "certificateId",
                "shipToState",
                "shipToPostalCode",
                "taxCode",
            ] {
                extra.insert(key.to_owned(), f.get(key).cloned().unwrap_or(Value::Null));
            }
            extra.insert(
                "marketplaceFacilitated".to_owned(),
                f.get("marketplaceFacilitated")
                    .cloned()
                    .unwrap_or(json!(false)),
            );
            for key in ["unroundedTaxAmount", "engine", "engineRef"] {
                extra.insert(key.to_owned(), f.get(key).cloned().unwrap_or(Value::Null));
            }
            PostingTaxLine {
                source_line_id: field("sourceLineId"),
                direction: ctx.direction.to_owned(),
                tax_rate_id: None,
                tax_rate_name: field("taxRateName"),
                rate: number(row, "taxRate"),
                self_assessed: flag(row, "selfAssessed"),
                jurisdiction_code: field("jurisdictionCode"),
                jurisdiction_level: field("jurisdictionLevel"),
                state_code: field("stateCode"),
                taxable_amount: taxable,
                tax_amount: tax,
                currency: ctx.currency.clone(),
                base_taxable_amount: to_base.apply(taxable),
                base_tax_amount: to_base.apply(tax),
                contact_id: ctx.contact_id.clone(),
                extra,
                ..PostingTaxLine::default()
            }
        })
        .collect()
}

/// The first `stateCode` of the rows (`rows.find((r) => r.stateCode)?.stateCode`).
fn first_state(rows: &[Value]) -> Option<String> {
    rows.iter()
        .find_map(|r| filled(r, "stateCode"))
        .map(str::to_owned)
}

/// The ship-to ZIP stored with a US document's tax rows: the shipping
/// address, else the billing address (`pickShipToZip`).
fn pick_ship_to_zip(invoice: &Value) -> Option<String> {
    zip5_of(
        pick_ship_to(&[
            invoice.get("shippingAddress"),
            invoice.get("billingAddress"),
        ])
        .as_ref(),
    )
}

/// An entity whose adapter posts supplier tax into the cost (US).
fn purchase_tax_is_cost(entity: &Value) -> bool {
    let code = text(entity, "jurisdictionCode").unwrap_or_default();
    has_adapter(code) && adapter(code).is_some_and(|a| a.purchase_tax == Some("cost"))
}

/// Journal amounts per account and reporting dimensions, so a class or
/// location splits the line (`DimensionedAmounts`).
#[derive(Debug, Default)]
struct DimensionedAmounts {
    amounts: Vec<(String, Option<String>, Option<String>, f64)>,
}

impl DimensionedAmounts {
    fn add(&mut self, account_id: &str, amount: f64, dims: &Value) {
        let class_id = owned(dims, "classId");
        let location_id = owned(dims, "locationId");
        let key = |c: &Option<String>, l: &Option<String>| {
            (c.clone().unwrap_or_default(), l.clone().unwrap_or_default())
        };
        let wanted = key(&class_id, &location_id);
        match self
            .amounts
            .iter_mut()
            .find(|(a, c, l, _)| a == account_id && key(c, l) == wanted)
        {
            Some(entry) => entry.3 += amount,
            None => self
                .amounts
                .push((account_id.to_owned(), class_id, location_id, amount)),
        }
    }
}

/// Brazil: what a bill's taxes do to the cost of its lines. A credit inside
/// the price comes out of the cost (it is booked as a receivable); a tax on
/// top that can't be credited goes into it. Spread to the cent.
fn adjust_br_purchase_cost(
    expenses: &mut DimensionedAmounts,
    breakdown: &[Value],
    items: &[Value],
    account_of: impl Fn(&Value) -> Option<String>,
) {
    for row in breakdown {
        let treatment = text(row, "treatment");
        let role = filled(row, "accountRole");
        let direction = if treatment == Some("embedded") && role.is_some() {
            -1.0
        } else if treatment == Some("added") && role.is_none() {
            1.0
        } else {
            0.0
        };
        let tax = number(row, "taxAmount");
        if direction == 0.0 || tax == 0.0 {
            continue;
        }
        let rate_id = text(row, "taxRateId");
        let lines: Vec<&Value> = items
            .iter()
            .filter(|item| Some(text(item, "taxRateId").unwrap_or_default()) == rate_id)
            .collect();
        if lines.is_empty() {
            continue;
        }
        let weights: Vec<f64> = lines
            .iter()
            .map(|item| amount_of(item, "lineTotal"))
            .collect();
        let parts = allocate_cents(to_cents(tax), &weights);
        for (item, part) in lines.into_iter().zip(parts) {
            if let Some(account_id) = account_of(item) {
                expenses.add(&account_id, direction * from_cents(part), item);
            }
        }
    }
}

/// Where the tax rows of an invoice or bill post, and how they convert.
struct TaxPosting<'a> {
    accounts: &'a EntityAccounts,
    rates: &'a HashMap<String, Value>,
    args: TaxArgs<'a>,
    document_number: Option<&'a str>,
    meta: Meta,
    lines: Vec<PostingLine>,
    tax_lines: Vec<PostingTaxLine>,
}

/// The `...meta` every line of a document carries.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub currency: Option<String>,
    pub exchange_rate: Option<String>,
    pub contact_id: Option<String>,
}

impl Meta {
    /// A line with this meta (`{ accountId, ..., ...meta }`).
    pub fn line(&self, account_id: String, description: String) -> PostingLine {
        PostingLine {
            account_id,
            description: Some(description),
            currency: self.currency.clone(),
            exchange_rate: self.exchange_rate.clone(),
            contact_id: self.contact_id.clone(),
            ..PostingLine::default()
        }
    }
}

fn debit(mut line: PostingLine, amount: f64) -> PostingLine {
    line.debit = amount;
    line
}

fn credit(mut line: PostingLine, amount: f64) -> PostingLine {
    line.credit = amount;
    line
}

fn with_tax(mut line: PostingLine, rate_id: Option<&str>, amount: f64) -> PostingLine {
    line.tax_rate_id = rate_id.filter(|id| !id.is_empty()).map(str::to_owned);
    line.tax_amount = Some(amount);
    line
}

fn with_dims(
    mut line: PostingLine,
    class_id: Option<String>,
    location_id: Option<String>,
) -> PostingLine {
    line.class_id = class_id;
    line.location_id = location_id;
    line
}

impl TaxPosting<'_> {
    fn row_tax_line(&self, row: &Value, rate: Option<&Value>, purchase: bool) -> PostingTaxLine {
        let args = TaxArgs {
            purchase,
            ..self.args.clone()
        };
        breakdown_to_tax_line(row, rate, &args)
    }

    fn base(&self, row: &Value) -> f64 {
        self.args
            .to_base
            .apply(number(row, "taxAmount") * self.args.sign)
    }

    fn row_label(&self, row: &Value, suffix: &str) -> String {
        let name = row
            .get("taxRateName")
            .filter(|v| !v.is_null())
            .and_then(Value::as_str)
            .unwrap_or("Tax");
        label(&format!("{name}{suffix}"), self.document_number)
    }
}

// ── invoices and credit notes ───────────────────────────────────────────────

/// Revenue per account and dimensions: the line's own account, else the
/// invoice's default.
fn invoice_revenue(
    items: &[Value],
    accounts: &EntityAccounts,
    default_revenue: Option<&Value>,
) -> Result<DimensionedAmounts, PostError> {
    let mut revenue = DimensionedAmounts::default();
    for item in items {
        let account = filled(item, "accountId");
        if let Some(account) = account
            && accounts.by_id(Some(account)).is_none()
        {
            return Err(posting(format!(
                "Line account {account} does not belong to this accounting entity"
            )));
        }
        let account_id = require_account(
            accounts.by_id(account).or(default_revenue),
            "No revenue account found. Choose a revenue account on the invoice line.",
        )?;
        revenue.add(&account_id, amount_of(item, "lineTotal"), item);
    }
    Ok(revenue)
}

/// US sales tax: a credit per agency's payable account, and the
/// per-jurisdiction tax-ledger rows.
async fn post_invoice_sales_tax(
    db: &PgPool,
    invoice: &Value,
    breakdown: &[Value],
    posting: &mut TaxPosting<'_>,
) -> Result<(), PostError> {
    let entity_id = text(invoice, "entityId").unwrap_or_default();
    let agencies = load_agency_accounts(db, entity_id).await?;
    let mut payable: Vec<(String, f64, String)> = Vec::new();
    for row in breakdown {
        let tax = number(row, "taxAmount");
        if tax == 0.0 {
            continue;
        }
        let agency_id = filled(row, "agencyId");
        let account_id = sales_tax_account_for(posting.accounts, &agencies, agency_id)?;
        let name = agency_id
            .map_or("Sales tax", |id| {
                agencies
                    .get(id)
                    .and_then(|a| a.name.as_deref())
                    .unwrap_or("Sales tax")
            })
            .to_owned();
        match payable.iter_mut().find(|(id, _, _)| *id == account_id) {
            Some(entry) => entry.1 += tax,
            None => payable.push((account_id, tax, name)),
        }
    }
    let sign = posting.args.sign;
    let to_base = posting.args.to_base;
    let number_of = text(invoice, "invoiceNumber");
    for (account_id, amount, name) in payable {
        let base = to_base.apply(amount * sign);
        let line = posting
            .meta
            .line(account_id, label(&format!("Sales tax {name}"), number_of));
        let mut line = credit(line, base);
        line.tax_amount = Some(base);
        posting.lines.push(line);
    }
    let lines = us_tax_lines(
        breakdown,
        &UsTaxContext {
            sign,
            direction: "sales",
            currency: posting.args.currency.to_owned(),
            contact_id: owned(invoice, "contactId"),
            marketplace_facilitated: flag(invoice, "marketplaceFacilitated"),
            ship_to_state: first_state(breakdown),
            ship_to_postal_code: pick_ship_to_zip(invoice),
            engine: owned(invoice, "taxEngine"),
            engine_ref: owned(invoice, "taxEngineRef"),
        },
        to_base,
    );
    posting.tax_lines.extend(lines);
    Ok(())
}

/// Tax rows with a rate (or a BR withholding) on an invoice: journal lines
/// and tax-ledger rows.
fn post_invoice_rate_tax(
    breakdown: &[Value],
    posting: &mut TaxPosting<'_>,
) -> Result<(), PostError> {
    for row in breakdown {
        let rate = rate_for(posting.rates, row);
        let treatment = text(row, "treatment");
        if treatment == Some("informational") {
            // BR CBS/IBS of the 2026 test year: on the tax ledger, nothing in the journal.
            let line = posting.row_tax_line(row, rate, false);
            posting.tax_lines.push(line);
            continue;
        }
        if number(row, "taxAmount") != 0.0 {
            let lines = invoice_tax_row_lines(row, rate, posting)?;
            posting.lines.extend(lines);
        }
        // Withholdings are document-level (no rate) but still reach the tax ledger.
        if filled(row, "taxRateId").is_some() || treatment == Some("withheld") {
            let line = posting.row_tax_line(row, rate, false);
            posting.tax_lines.push(line);
        }
    }
    Ok(())
}

/// The journal lines of an invoice tax row with a non-zero amount.
fn invoice_tax_row_lines(
    row: &Value,
    rate: Option<&Value>,
    posting: &TaxPosting<'_>,
) -> Result<Vec<PostingLine>, PostError> {
    let description = posting.row_label(row, "");
    let amount = posting.base(row);
    let rate_id = text(row, "taxRateId");
    match text(row, "treatment") {
        Some("withheld") => {
            // Kept back by the customer: a receivable from the tax authority.
            let account = role_account(posting.accounts, text(row, "accountRole"), &description)?;
            Ok(vec![debit(posting.meta.line(account, description), amount)])
        }
        Some("embedded") => {
            // Inside the price: a deduction from revenue against the tax payable.
            let offset = role_account(
                posting.accounts,
                text(row, "offsetAccountRole"),
                &description,
            )?;
            let payable = role_account(posting.accounts, text(row, "accountRole"), &description)?;
            Ok(vec![
                debit(posting.meta.line(offset, description.clone()), amount),
                with_tax(
                    credit(posting.meta.line(payable, description), amount),
                    rate_id,
                    amount,
                ),
            ])
        }
        _ => {
            let account = tax_account_for(posting.accounts, row, rate, false)?;
            Ok(vec![with_tax(
                credit(posting.meta.line(account, description), amount),
                rate_id,
                amount,
            )])
        }
    }
}

/// What a document posts: its lines, tax-ledger rows and the rate it posts at.
#[derive(Debug, Clone)]
pub struct DocumentPosting {
    pub lines: Vec<PostingLine>,
    pub tax_lines: Vec<PostingTaxLine>,
    pub exchange_rate: String,
}

/// `buildInvoicePosting(db, invoice, items)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn build_invoice_posting(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    invoice: &Value,
    items: &[Value],
) -> Result<DocumentPosting, PostError> {
    let entity_id = text(invoice, "entityId").unwrap_or_default();
    let entity = load_entity(db, entity_id).await?;
    let accounts = load_entity_accounts(db, entity_id).await?;
    let breakdown = breakdown_of(invoice);
    // A US document calculated by the sales tax engine: tax per jurisdiction and agency, no rate rows.
    let sales_tax = filled(invoice, "taxEngine").is_some();
    let rates = if sales_tax {
        HashMap::new()
    } else {
        load_tax_rates(
            db,
            entity_id,
            breakdown.iter().map(|r| text(r, "taxRateId")),
        )
        .await?
    };
    let (party_revenue, _) = load_party(db, text(invoice, "contactId")).await?;

    let sign = if text(invoice, "type") == Some("credit_note") {
        -1.0
    } else {
        1.0
    };
    let base_currency = text(&entity, "baseCurrency").unwrap_or_default();
    let currency = filled(invoice, "currency")
        .unwrap_or(base_currency)
        .to_owned();
    // The rate on the document, or the one for its date; refuses to go on without one.
    let exchange_rate = require_booking_rate(
        db,
        http,
        base_currency,
        text(invoice, "currency"),
        millis(invoice, "issueDate"),
        invoice.get("exchangeRate"),
    )
    .await?;
    let to_base = base_converter(&entity, text(invoice, "currency"), &json!(exchange_rate))?;
    let meta = Meta {
        currency: Some(currency.clone()),
        exchange_rate: Some(exchange_rate.clone()),
        contact_id: owned(invoice, "contactId"),
    };

    let revenue_account = filled(invoice, "revenueAccountId");
    let default_revenue = accounts
        .by_id(revenue_account)
        .or_else(|| accounts.by_id(party_revenue.as_deref()))
        .or_else(|| account_for_role(&accounts, "sales_revenue", fallback::SALES_REVENUE));
    if revenue_account.is_some() && accounts.by_id(revenue_account).is_none() {
        return Err(posting(
            "revenueAccountId does not belong to this accounting entity",
        ));
    }
    let revenue = invoice_revenue(items, &accounts, default_revenue)?;
    let number_of = text(invoice, "invoiceNumber");

    let mut lines = Vec::new();
    for (account_id, class_id, location_id, amount) in revenue.amounts {
        let line = meta.line(account_id, label("Revenue", number_of));
        lines.push(with_dims(
            credit(line, to_base.apply(amount * sign)),
            class_id,
            location_id,
        ));
    }

    let mut posting = TaxPosting {
        accounts: &accounts,
        rates: &rates,
        args: TaxArgs {
            purchase: false,
            sign,
            currency: &currency,
            to_base,
            contact_id: text(invoice, "contactId"),
        },
        document_number: number_of,
        meta: meta.clone(),
        lines,
        tax_lines: Vec::new(),
    };
    if sales_tax {
        post_invoice_sales_tax(db, invoice, &breakdown, &mut posting).await?;
    } else {
        post_invoice_rate_tax(&breakdown, &mut posting)?;
    }
    let TaxPosting {
        mut lines,
        tax_lines,
        ..
    } = posting;

    // The receivable balances the entry: what was credited less what was debited.
    let receivable = round_money(lines.iter().fold(0.0, |sum, l| sum + l.credit - l.debit));
    let kind = if sign < 0.0 { "Credit note" } else { "Invoice" };
    let account = require_account(
        account_for_role(
            &accounts,
            "accounts_receivable",
            fallback::ACCOUNTS_RECEIVABLE,
        ),
        "No accounts receivable account found for this entity.",
    )?;
    lines.insert(
        0,
        debit(meta.line(account, label(kind, number_of)), receivable),
    );
    Ok(DocumentPosting {
        lines,
        tax_lines,
        exchange_rate,
    })
}

/// An `UPDATE` of one row written with the entry, `journalEntryId` set to
/// the posted entry's id when `entry_key` names it.
pub fn update_with_entry(
    table: &'static crate::table::Table,
    id: String,
    mut set: Map<String, Value>,
    entry_key: Option<&'static str>,
) -> AlsoWrite {
    Box::new(move |conn, posted| {
        Box::pin(async move {
            if let Some(key) = entry_key {
                set.insert(key.to_owned(), json!(posted.journal_entry_id));
            }
            table
                .patch_raw(&mut *conn, &id, table.values(&set), false)
                .await?;
            Ok(())
        })
    })
}

/// `postInvoice` options.
#[derive(Debug, Clone, Default)]
pub struct PostInvoiceOptions {
    pub user_id: Option<String>,
    pub mark_sent: bool,
    pub keep_status: bool,
    /// Facts stored on the invoice when it is booked (`contactTaxNumber`,
    /// `placeOfSupply`), as invoice properties.
    pub snapshot: Map<String, Value>,
}

/// `postInvoice(db, invoice, items, opts)`: a draft invoice or credit note
/// becomes `finalized` (or, with `mark_sent`, `sent`).
pub async fn post_invoice(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    invoice: &Value,
    items: &[Value],
    opts: PostInvoiceOptions,
) -> Result<PostedEntry, PostError> {
    let built = build_invoice_posting(db, http, invoice, items).await?;
    let credit_note = text(invoice, "type") == Some("credit_note");
    let at = now();
    let id = text(invoice, "id").unwrap_or_default().to_owned();
    let mut set = Map::new();
    // The catch-up books invoices that are already sent or paid: their status stays.
    if !opts.keep_status {
        set.insert(
            "status".to_owned(),
            json!(if opts.mark_sent { "sent" } else { "finalized" }),
        );
    }
    // The rate the entry was posted at stays on the document.
    set.insert("exchangeRate".to_owned(), json!(built.exchange_rate));
    set.insert("journalEntryId".to_owned(), Value::Null);
    for (key, value) in opts.snapshot {
        set.insert(key, value);
    }
    if opts.mark_sent {
        set.insert("sentAt".to_owned(), json!(at));
    }
    set.insert("updatedAt".to_owned(), json!(at));
    let kind = if credit_note {
        "Credit note"
    } else {
        "Invoice"
    };
    post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: text(invoice, "entityId").unwrap_or_default().to_owned(),
            date: text(invoice, "issueDate").unwrap_or_default().to_owned(),
            description: js_trim(&format!(
                "{kind} {} - {}",
                text(invoice, "invoiceNumber").unwrap_or_default(),
                text(invoice, "contactName").unwrap_or_default()
            ))
            .to_owned(),
            reference: owned(invoice, "reference"),
            source_type: if credit_note {
                "credit_note"
            } else {
                "invoice"
            }
            .to_owned(),
            source_id: Some(id.clone()),
            posting_key: Some(format!("invoice:{id}:issue")),
            lock_kind: Some(PostingLockKind::Sales),
            lines: built.lines,
            tax_lines: built.tax_lines,
            created_by: opts.user_id,
            also_write: vec![update_with_entry(
                &INVOICES,
                id,
                set,
                Some("journalEntryId"),
            )],
            ..PostJournalEntryInput::default()
        },
    )
    .await
}

/// `writeOffTaxRows(invoice)`: the open share of each taxed row, as the
/// rows of a bad debt; the parts add up to the open share of the tax, to the
/// cent. Also the total in cents.
pub fn write_off_tax_rows(invoice: &Value) -> (Vec<Value>, i64) {
    let total = amount_of(invoice, "total");
    let open = amount_of(invoice, "balanceDue");
    let breakdown = breakdown_of(invoice);
    let taxed: Vec<&Value> = breakdown
        .iter()
        .filter(|r| number(r, "taxAmount") != 0.0)
        .collect();
    if total <= 0.0 || open <= 0.0 || taxed.is_empty() {
        return (Vec::new(), 0);
    }
    let share = (open / total).min(1.0);
    let invoice_tax_cents: i64 = taxed.iter().map(|r| to_cents(number(r, "taxAmount"))).sum();
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let tax_cents = math_round(invoice_tax_cents as f64 * share) as i64;
    let weights: Vec<f64> = taxed.iter().map(|r| number(r, "taxAmount")).collect();
    let parts = allocate_cents(tax_cents, &weights);
    let rows = taxed
        .iter()
        .zip(parts)
        .map(|(row, part)| {
            let mut row = (*row).clone();
            let tax = from_cents(part);
            let taxable = round_half_up(number(&row, "taxableAmount") * share, 2);
            if let Some(object) = row.as_object_mut() {
                object.insert("taxableAmount".to_owned(), number_value(taxable));
                object.insert("taxAmount".to_owned(), number_value(tax));
                object.insert("unroundedTaxAmount".to_owned(), number_value(tax));
                object.insert("exemptAmount".to_owned(), json!(0));
                object.insert("nonTaxableAmount".to_owned(), json!(0));
            }
            row
        })
        .collect();
    (rows, tax_cents)
}

/// `postInvoiceWriteOff(db, invoice, opts)`: an invoice's open balance to
/// bad debts (a US invoice's sales tax back off the agency's payable).
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn post_invoice_write_off(
    db: &PgPool,
    invoice: &Value,
    user_id: Option<String>,
    date: Option<String>,
) -> Result<PostedEntry, PostError> {
    let entity_id = text(invoice, "entityId").unwrap_or_default();
    let entity = load_entity(db, entity_id).await?;
    let accounts = load_entity_accounts(db, entity_id).await?;
    let to_base = base_converter(
        &entity,
        text(invoice, "currency"),
        invoice.get("exchangeRate").unwrap_or(&Value::Null),
    )?;
    let open = to_base.apply(amount_of(invoice, "balanceDue"));
    let bad_debt = account_for_role(&accounts, "bad_debt_expense", &[])
        .or_else(|| account_for_role(&accounts, "general_expense", fallback::GENERAL_EXPENSE));
    let meta = Meta {
        currency: owned(invoice, "currency"),
        exchange_rate: Some(owned(invoice, "exchangeRate").unwrap_or_else(|| "1".to_owned())),
        contact_id: owned(invoice, "contactId"),
    };
    let date = date.unwrap_or_else(now);
    let number_of = text(invoice, "invoiceNumber");

    // US sales tax already booked comes back off the agency's payable: the bad debt is only the net.
    let rows =
        if filled(invoice, "taxEngine").is_some() && text(invoice, "type") != Some("credit_note") {
            write_off_tax_rows(invoice).0
        } else {
            Vec::new()
        };
    let mut tax_lines = Vec::new();
    let mut tax_debits = Vec::new();
    if !rows.is_empty() {
        let agencies = load_agency_accounts(db, entity_id).await?;
        let mut by_account: Vec<(String, f64)> = Vec::new();
        for row in &rows {
            let account_id = sales_tax_account_for(&accounts, &agencies, filled(row, "agencyId"))?;
            let tax = number(row, "taxAmount");
            match by_account.iter_mut().find(|(id, _)| *id == account_id) {
                Some(entry) => entry.1 += tax,
                None => by_account.push((account_id, 0.0 + tax)),
            }
        }
        for (account_id, amount) in by_account {
            tax_debits.push(debit(
                meta.line(account_id, label("Sales tax written off", number_of)),
                to_base.apply(amount),
            ));
        }
        let base_currency = text(&entity, "baseCurrency").unwrap_or_default();
        tax_lines = us_tax_lines(
            &rows,
            &UsTaxContext {
                sign: -1.0,
                direction: "sales",
                currency: filled(invoice, "currency")
                    .unwrap_or(base_currency)
                    .to_owned(),
                contact_id: owned(invoice, "contactId"),
                marketplace_facilitated: flag(invoice, "marketplaceFacilitated"),
                ship_to_state: first_state(&rows),
                ship_to_postal_code: pick_ship_to_zip(invoice),
                engine: owned(invoice, "taxEngine"),
                engine_ref: owned(invoice, "taxEngineRef"),
            },
            to_base,
        );
    }
    let tax_base = round_money(tax_debits.iter().fold(0.0, |sum, l| sum + l.debit));

    let id = text(invoice, "id").unwrap_or_default().to_owned();
    let mut lines = vec![debit(
        meta.line(
            require_account(
                bad_debt,
                "No bad-debt or general expense account found for this entity.",
            )?,
            label("Bad debt", number_of),
        ),
        round_money(open - tax_base),
    )];
    lines.extend(tax_debits);
    lines.push(credit(
        meta.line(
            require_account(
                account_for_role(
                    &accounts,
                    "accounts_receivable",
                    fallback::ACCOUNTS_RECEIVABLE,
                ),
                "No accounts receivable account found for this entity.",
            )?,
            label("Write-off", number_of),
        ),
        open,
    ));
    post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.to_owned(),
            date,
            description: write_off_description(invoice),
            source_type: "write_off".to_owned(),
            source_id: Some(id.clone()),
            posting_key: Some(format!("invoice:{id}:write_off")),
            lock_kind: Some(PostingLockKind::Sales),
            lines,
            tax_lines,
            created_by: user_id,
            also_write: vec![mark_uncollectible(id)],
            ..PostJournalEntryInput::default()
        },
    )
    .await
}

/// `Write-off <number> - <contact>`.
pub(crate) fn write_off_description(invoice: &Value) -> String {
    js_trim(&format!(
        "Write-off {} - {}",
        text(invoice, "invoiceNumber").unwrap_or_default(),
        text(invoice, "contactName").unwrap_or_default()
    ))
    .to_owned()
}

/// The invoice of a write-off: `uncollectible`, nothing open.
pub(crate) fn mark_uncollectible(id: String) -> AlsoWrite {
    let mut set = Map::new();
    set.insert("status".to_owned(), json!("uncollectible"));
    set.insert("balanceDue".to_owned(), json!("0.00"));
    set.insert("updatedAt".to_owned(), json!(now()));
    update_with_entry(&INVOICES, id, set, None)
}

// ── bills ───────────────────────────────────────────────────────────────────

/// Expense per account and dimensions; supplier tax that can't be deducted
/// is part of the line's cost.
fn bill_expenses(
    items: &[Value],
    accounts: &EntityAccounts,
    default_expense: Option<&Value>,
    tax_deductible: bool,
) -> Result<DimensionedAmounts, PostError> {
    let mut expenses = DimensionedAmounts::default();
    for item in items {
        let account = filled(item, "accountId");
        if let Some(account) = account
            && accounts.by_id(Some(account)).is_none()
        {
            return Err(posting(format!(
                "Line account {account} does not belong to this accounting entity"
            )));
        }
        let account_id = require_account(
            accounts.by_id(account).or(default_expense),
            "No expense account found. Choose an expense account on each bill line.",
        )?;
        let net = amount_of(item, "lineTotal");
        let tax = if tax_deductible {
            0.0
        } else {
            amount_of(item, "taxAmount")
        };
        expenses.add(&account_id, net + tax, item);
    }
    Ok(expenses)
}

/// Use tax the buyer accrues: Dr the line's expense or asset, Cr the
/// agency's Use Tax Payable.
async fn post_bill_use_tax(
    db: &PgPool,
    bill: &Value,
    use_rows: &[Value],
    items: &[Value],
    default_expense: Option<&Value>,
    posting: &mut TaxPosting<'_>,
) -> Result<(), PostError> {
    let entity_id = text(bill, "entityId").unwrap_or_default();
    let agencies = load_agency_accounts(db, entity_id).await?;
    let mut accrued = DimensionedAmounts::default();
    let mut owed: Vec<(String, f64)> = Vec::new();
    let empty = json!({});
    for row in use_rows {
        let tax = number(row, "taxAmount");
        if tax == 0.0 {
            continue;
        }
        let item = filled(row, "lineId")
            .and_then(|line| items.iter().find(|i| text(i, "id") == Some(line)));
        let expense = require_account(
            posting
                .accounts
                .by_id(item.and_then(|i| text(i, "accountId")))
                .or(default_expense),
            "No expense account found for use tax.",
        )?;
        accrued.add(&expense, tax, item.unwrap_or(&empty));
        let payable = use_tax_account_for(posting.accounts, &agencies, filled(row, "agencyId"))?;
        match owed.iter_mut().find(|(id, _)| *id == payable) {
            Some(entry) => entry.1 += tax,
            None => owed.push((payable, 0.0 + tax)),
        }
    }
    let sign = posting.args.sign;
    let to_base = posting.args.to_base;
    let number_of = text(bill, "billNumber");
    for (account_id, class_id, location_id, amount) in accrued.amounts {
        let line = posting.meta.line(account_id, label("Use tax", number_of));
        posting.lines.push(with_dims(
            debit(line, to_base.apply(amount * sign)),
            class_id,
            location_id,
        ));
    }
    for (account_id, amount) in owed {
        let base = to_base.apply(amount * sign);
        let mut line = credit(
            posting.meta.line(account_id, label("Use tax", number_of)),
            base,
        );
        line.tax_amount = Some(base);
        posting.lines.push(line);
    }
    let lines = us_tax_lines(
        use_rows,
        &UsTaxContext {
            sign,
            direction: "use",
            currency: posting.args.currency.to_owned(),
            contact_id: owned(bill, "contactId"),
            marketplace_facilitated: false,
            ship_to_state: first_state(use_rows),
            ship_to_postal_code: zip5_of(pick_ship_to(&[bill.get("deliveryAddress")]).as_ref()),
            engine: None,
            engine_ref: None,
        },
        to_base,
    );
    posting.tax_lines.extend(lines);
    Ok(())
}

/// One non-use tax row of a bill: its journal lines and, when it counts, its
/// tax-ledger row.
fn post_bill_tax_row(
    row: &Value,
    posting: &mut TaxPosting<'_>,
    tax_deductible: bool,
    default_expense: Option<&Value>,
) -> Result<(), PostError> {
    let rate = rate_for(posting.rates, row);
    let treatment = filled(row, "treatment");
    if treatment.is_some_and(|t| t != "added") {
        return post_br_bill_tax_row(row, rate, posting);
    }
    if treatment == Some("added") && filled(row, "accountRole").is_none() {
        return Ok(()); // BR tax without a credit: part of the cost
    }
    let tax = number(row, "taxAmount");
    if flag(row, "selfAssessed") {
        // Owed and deducted by the buyer itself: both legs, nothing to the supplier.
        if tax != 0.0 {
            let lines =
                self_assessed_tax_lines(row, rate, posting, tax_deductible, default_expense)?;
            posting.lines.extend(lines);
        }
    } else if tax_deductible && tax != 0.0 {
        let account = tax_account_for(posting.accounts, row, rate, true)?;
        let amount = posting.base(row);
        let line = posting.meta.line(account, posting.row_label(row, ""));
        posting.lines.push(with_tax(
            debit(line, amount),
            text(row, "taxRateId"),
            amount,
        ));
    }
    if filled(row, "taxRateId").is_some() && tax_deductible {
        let line = posting.row_tax_line(row, rate, true);
        posting.tax_lines.push(line);
    }
    Ok(())
}

/// Brazil: a credit inside the price (Dr recoverable, already out of the
/// cost) or a withholding (Cr payable).
fn post_br_bill_tax_row(
    row: &Value,
    rate: Option<&Value>,
    posting: &mut TaxPosting<'_>,
) -> Result<(), PostError> {
    let treatment = text(row, "treatment");
    let role = filled(row, "accountRole");
    if treatment == Some("informational") || role.is_none() || number(row, "taxAmount") == 0.0 {
        return Ok(());
    }
    let description = posting.row_label(row, "");
    let amount = posting.base(row);
    let account = role_account(posting.accounts, role, &description)?;
    let line = posting.meta.line(account, description);
    posting.lines.push(if treatment == Some("withheld") {
        credit(line, amount)
    } else {
        with_tax(debit(line, amount), text(row, "taxRateId"), amount)
    });
    let line = posting.row_tax_line(row, rate, true);
    posting.tax_lines.push(line);
    Ok(())
}

/// Both legs of a self-assessed tax row: the deduction (or the cost, when
/// not deductible) and the tax payable.
fn self_assessed_tax_lines(
    row: &Value,
    rate: Option<&Value>,
    posting: &TaxPosting<'_>,
    tax_deductible: bool,
    default_expense: Option<&Value>,
) -> Result<Vec<PostingLine>, PostError> {
    let accounts = posting.accounts;
    let amount = posting.base(row);
    let rate_id = text(row, "taxRateId");
    let mut lines = Vec::new();
    if tax_deductible {
        let account = tax_account_for(accounts, row, rate, true)?;
        let line = posting
            .meta
            .line(account, posting.row_label(row, " (self-assessed)"));
        lines.push(with_tax(debit(line, amount), rate_id, amount));
    } else {
        let account = require_account(
            default_expense,
            "No expense account found for non-deductible tax.",
        )?;
        let line = posting.meta.line(
            account,
            posting.row_label(row, " (self-assessed, not deductible)"),
        );
        lines.push(debit(line, amount));
    }
    let payable = require_account(
        account_for_role(accounts, "tax_payable", fallback::TAX_PAYABLE)
            .or_else(|| account_for_role(accounts, "use_tax_payable", &[]))
            .or_else(|| account_for_role(accounts, "sales_tax_payable", &[])),
        "No tax payable account found for this entity.",
    )?;
    let line = posting
        .meta
        .line(payable, posting.row_label(row, " (self-assessed)"));
    lines.push(with_tax(credit(line, amount), rate_id, amount));
    Ok(lines)
}

/// `buildBillPosting(db, bill, items)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn build_bill_posting(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    bill: &Value,
    items: &[Value],
) -> Result<DocumentPosting, PostError> {
    let entity_id = text(bill, "entityId").unwrap_or_default();
    let entity = load_entity(db, entity_id).await?;
    let accounts = load_entity_accounts(db, entity_id).await?;
    let breakdown = breakdown_of(bill);
    let rates = load_tax_rates(
        db,
        entity_id,
        breakdown.iter().map(|r| text(r, "taxRateId")),
    )
    .await?;
    let (_, party_expense) = load_party(db, text(bill, "contactId")).await?;

    let sign = if text(bill, "type") == Some("credit_note") {
        -1.0
    } else {
        1.0
    };
    let base_currency = text(&entity, "baseCurrency").unwrap_or_default();
    let currency = filled(bill, "currency").unwrap_or(base_currency).to_owned();
    let issue = millis(bill, "issueDate");
    let exchange_rate = require_booking_rate(
        db,
        http,
        base_currency,
        text(bill, "currency"),
        issue,
        bill.get("exchangeRate"),
    )
    .await?;
    let to_base = base_converter(&entity, text(bill, "currency"), &json!(exchange_rate))?;
    let meta = Meta {
        currency: Some(currency.clone()),
        exchange_rate: Some(exchange_rate.clone()),
        contact_id: owned(bill, "contactId"),
    };
    // Supplier tax is part of the cost under the Dutch KOR and in the US.
    let tax_deductible = !purchase_tax_is_cost(&entity)
        && !is_kor_active(
            text(&entity, "jurisdictionCode").unwrap_or_default(),
            entity.get("jurisdictionSettings"),
            issue,
        );

    let expense_account = filled(bill, "expenseAccountId");
    if expense_account.is_some() && accounts.by_id(expense_account).is_none() {
        return Err(posting(
            "expenseAccountId does not belong to this accounting entity",
        ));
    }
    let default_expense = accounts
        .by_id(expense_account)
        .or_else(|| accounts.by_id(party_expense.as_deref()))
        .or_else(|| account_for_role(&accounts, "general_expense", fallback::GENERAL_EXPENSE));

    let mut expenses = bill_expenses(items, &accounts, default_expense, tax_deductible)?;
    adjust_br_purchase_cost(&mut expenses, &breakdown, items, |item| {
        accounts
            .by_id(text(item, "accountId"))
            .or(default_expense)
            .map(id_of)
    });

    let number_of = text(bill, "billNumber");
    let mut lines = Vec::new();
    for (account_id, class_id, location_id, amount) in expenses.amounts {
        let line = meta.line(account_id, label("Expense", number_of));
        lines.push(with_dims(
            debit(line, to_base.apply(amount * sign)),
            class_id,
            location_id,
        ));
    }

    let mut posting = TaxPosting {
        accounts: &accounts,
        rates: &rates,
        args: TaxArgs {
            purchase: true,
            sign,
            currency: &currency,
            to_base,
            contact_id: text(bill, "contactId"),
        },
        document_number: number_of,
        meta: meta.clone(),
        lines,
        tax_lines: Vec::new(),
    };
    let use_rows: Vec<Value> = breakdown
        .iter()
        .filter(|r| text(r, "kind") == Some("use"))
        .cloned()
        .collect();
    if !use_rows.is_empty() {
        post_bill_use_tax(db, bill, &use_rows, items, default_expense, &mut posting).await?;
    }
    for row in &breakdown {
        if text(row, "kind") == Some("use") {
            continue;
        }
        post_bill_tax_row(row, &mut posting, tax_deductible, default_expense)?;
    }
    let TaxPosting {
        mut lines,
        tax_lines,
        ..
    } = posting;

    // Payable = everything debited except the self-assessed pairs, which net out.
    let debits = round_money(lines.iter().fold(0.0, |sum, l| sum + l.debit));
    let other_credits = round_money(lines.iter().fold(0.0, |sum, l| sum + l.credit));
    let account = require_account(
        account_for_role(&accounts, "accounts_payable", fallback::ACCOUNTS_PAYABLE),
        "No accounts payable account found for this entity.",
    )?;
    lines.push(credit(
        meta.line(account, label("Bill", number_of)),
        round_money(debits - other_credits),
    ));
    Ok(DocumentPosting {
        lines,
        tax_lines,
        exchange_rate,
    })
}

/// `postBill(db, bill, items, opts)`: post an approved bill.
pub async fn post_bill(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    bill: &Value,
    items: &[Value],
    user_id: Option<String>,
    keep_status: bool,
) -> Result<PostedEntry, PostError> {
    let built = build_bill_posting(db, http, bill, items).await?;
    let at = now();
    let id = text(bill, "id").unwrap_or_default().to_owned();
    let mut set = Map::new();
    set.insert("exchangeRate".to_owned(), json!(built.exchange_rate));
    if !keep_status {
        set.insert("approvalStatus".to_owned(), json!("approved"));
        set.insert("status".to_owned(), json!("approved"));
        set.insert("approvedBy".to_owned(), json!(user_id));
        set.insert("approvedAt".to_owned(), json!(at));
    }
    set.insert("journalEntryId".to_owned(), Value::Null);
    set.insert("updatedAt".to_owned(), json!(at));
    post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: text(bill, "entityId").unwrap_or_default().to_owned(),
            date: text(bill, "issueDate").unwrap_or_default().to_owned(),
            description: js_trim(&format!(
                "Bill {} - {}",
                text(bill, "billNumber").unwrap_or_default(),
                text(bill, "contactName").unwrap_or_default()
            ))
            .to_owned(),
            reference: owned(bill, "externalReference").or_else(|| owned(bill, "reference")),
            source_type: if text(bill, "type") == Some("credit_note") {
                "bill_credit_note"
            } else {
                "bill"
            }
            .to_owned(),
            source_id: Some(id.clone()),
            posting_key: Some(format!("bill:{id}:approve")),
            lock_kind: Some(PostingLockKind::Purchase),
            lines: built.lines,
            tax_lines: built.tax_lines,
            created_by: user_id,
            also_write: vec![update_with_entry(&BILLS, id, set, Some("journalEntryId"))],
            ..PostJournalEntryInput::default()
        },
    )
    .await
}

// ── payments ────────────────────────────────────────────────────────────────

/// `resolveMoneyAccount(db, accounts, entity, args)`: the payment's bank
/// account's ledger account, the cash account for cash, else the entity's
/// default bank account.
pub async fn resolve_money_account(
    db: &PgPool,
    accounts: &EntityAccounts,
    entity: &Value,
    bank_account_id: Option<&str>,
    payment_method: Option<&str>,
) -> Result<String, PostError> {
    let entity_id = text(entity, "id").unwrap_or_default();
    if let Some(bank_account_id) = bank_account_id.filter(|id| !id.is_empty()) {
        let row: Option<(Option<String>,)> = sqlx::query_as(
            "select ledger_account_id from bank_accounts where id = $1 and entity_id = $2 and deleted_at is null limit 1",
        )
        .bind(bank_account_id)
        .bind(entity_id)
        .fetch_optional(db)
        .await?;
        let Some((ledger,)) = row else {
            return Err(posting("Bank account not found for this accounting entity"));
        };
        return require_account(
            accounts.by_id(ledger.as_deref()),
            "This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.",
        );
    }
    if payment_method == Some("cash")
        && let Some(cash) = accounts.by_subtype("cash")
    {
        return Ok(id_of(cash));
    }
    let default_bank: Option<(Option<String>,)> = sqlx::query_as(
        "select ledger_account_id from bank_accounts where entity_id = $1 and deleted_at is null \
         and ledger_account_id is not null order by is_default desc nulls last, created_at limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    if let Some(from_bank) = accounts.by_id(default_bank.and_then(|(id,)| id).as_deref()) {
        return Ok(id_of(from_bank));
    }
    // Template bank accounts: NL 1100 Bank, IN 1200 Bank.
    let code = if text(entity, "jurisdictionCode") == Some("IN") {
        "1200"
    } else {
        "1100"
    };
    if let Some(template) = accounts.by_code(code)
        && text(template, "subtype") == Some("bank")
    {
        return Ok(id_of(template));
    }
    require_account(
        accounts.by_subtype("bank"),
        "No bank account linked to the ledger. Add a bank account and link it to a GL account.",
    )
}

/// `PaymentAllocationInput`.
#[derive(Debug, Clone, Default)]
pub struct PaymentAllocationInput {
    pub invoice_id: Option<String>,
    pub bill_id: Option<String>,
    pub amount: f64,
    pub contact_id: String,
}

/// The payment `buildPaymentPosting` books.
#[derive(Debug, Clone, Default)]
pub struct PaymentPostingInput {
    pub entity_id: String,
    pub received: bool,
    pub amount: f64,
    pub currency: Option<String>,
    pub exchange_rate: Option<String>,
    pub contact_id: String,
    pub bank_account_id: Option<String>,
    pub payment_method: Option<String>,
    pub reference: Option<String>,
    /// The ledger account the money moves through (Undeposited Funds),
    /// instead of resolving the bank one.
    pub money_account_id: Option<String>,
    /// US backup withholding on a payment to a vendor.
    pub backup_withholding_amount: Option<f64>,
}

/// `buildPaymentPosting(db, payment, allocations)`: amounts in the payment
/// currency.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn build_payment_posting(
    db: &PgPool,
    payment: &PaymentPostingInput,
    allocations: &[PaymentAllocationInput],
) -> Result<Vec<PostingLine>, PostError> {
    let entity = load_entity(db, &payment.entity_id).await?;
    let accounts = load_entity_accounts(db, &payment.entity_id).await?;
    let to_base = base_converter(
        &entity,
        payment.currency.as_deref(),
        &payment
            .exchange_rate
            .as_ref()
            .map_or(Value::Null, |r| json!(r)),
    )?;
    let meta = Meta {
        currency: payment
            .currency
            .clone()
            .or_else(|| owned(&entity, "baseCurrency")),
        exchange_rate: Some(
            payment
                .exchange_rate
                .clone()
                .unwrap_or_else(|| "1".to_owned()),
        ),
        contact_id: None,
    };
    let received = payment.received;
    let receivable = || {
        require_account(
            account_for_role(
                &accounts,
                "accounts_receivable",
                fallback::ACCOUNTS_RECEIVABLE,
            ),
            "No accounts receivable account found for this entity.",
        )
    };
    let payable = || {
        require_account(
            account_for_role(&accounts, "accounts_payable", fallback::ACCOUNTS_PAYABLE),
            "No accounts payable account found for this entity.",
        )
    };
    let counter_account = if received { receivable()? } else { payable()? };
    let money_account = match payment
        .money_account_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        Some(id) => require_account(
            accounts.by_id(Some(id)),
            "The money account does not belong to this accounting entity",
        )?,
        None => {
            resolve_money_account(
                db,
                &accounts,
                &entity,
                payment.bank_account_id.as_deref(),
                payment.payment_method.as_deref(),
            )
            .await?
        }
    };

    let total = to_base.apply(payment.amount);
    let withheld = match payment.backup_withholding_amount {
        Some(amount) if amount != 0.0 && !amount.is_nan() => to_base.apply(amount),
        _ => 0.0,
    };
    if withheld < 0.0 || (withheld > 0.0 && (received || withheld > total)) {
        return Err(posting(
            "Backup withholding applies to payments to vendors and can not be more than the payment",
        ));
    }
    let reference = payment.reference.as_deref();
    let side = |line: PostingLine, amount: f64| {
        if received {
            credit(line, amount)
        } else {
            debit(line, amount)
        }
    };
    let mut counter_lines = Vec::new();
    let mut allocated = 0.0;
    for allocation in allocations {
        let amount = to_base.apply(allocation.amount);
        allocated = round_money(allocated + amount);
        let account = if allocation
            .invoice_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        {
            receivable()?
        } else if allocation
            .bill_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        {
            payable()?
        } else {
            counter_account.clone()
        };
        let mut line = side(meta.line(account, label("Payment", reference)), amount);
        line.contact_id = Some(allocation.contact_id.clone());
        counter_lines.push(line);
    }
    let unallocated = round_money(total - allocated);
    if unallocated < 0.0 {
        return Err(posting("Allocations exceed the payment amount"));
    }
    if unallocated > 0.0 {
        let mut line = side(
            meta.line(
                counter_account.clone(),
                label("Unapplied payment", reference),
            ),
            unallocated,
        );
        line.contact_id = Some(payment.contact_id.clone());
        counter_lines.push(line);
    }
    let mut withholding_lines = Vec::new();
    if withheld > 0.0 {
        let account = require_account(
            account_for_role(&accounts, "backup_withholding_payable", &["2310"]),
            "This accounting entity has no Backup Withholding Payable account",
        )?;
        let mut line = credit(
            meta.line(account, label("Backup withholding", reference)),
            withheld,
        );
        line.contact_id = Some(payment.contact_id.clone());
        withholding_lines.push(line);
    }

    let mut money = meta.line(
        money_account,
        label(
            if received {
                "Payment received"
            } else {
                "Payment sent"
            },
            reference,
        ),
    );
    money.contact_id = Some(payment.contact_id.clone());
    let net = round_money(total - withheld);
    let mut lines = vec![if received {
        debit(money, net)
    } else {
        credit(money, net)
    }];
    lines.extend(counter_lines);
    lines.extend(withholding_lines);
    Ok(lines)
}

/// `settlementSet(table, delta, unpaidStatus)` as one `UPDATE`: apply
/// `delta` (payment currency, negative when a payment is removed) to an
/// invoice's or bill's paid amount, balance and status in one statement, so
/// concurrent payments can't overwrite each other.
pub async fn settle(
    conn: &mut PgConnection,
    invoice: bool,
    id: &str,
    delta: f64,
) -> Result<(), sqlx::Error> {
    let statement = if invoice {
        // An invoice that was never sent goes back to 'finalized', not 'sent'.
        "update invoices set \
         amount_paid = (coalesce(amount_paid, '0')::numeric + $1::numeric), \
         balance_due = greatest((coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)), 0), \
         status = case when (coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)) <= 0.005 then 'paid' \
           when (coalesce(amount_paid, '0')::numeric + $1::numeric) <= 0.005 then \
             case when due_date < now() then 'overdue' when sent_at is not null then 'sent' else 'finalized' end \
           else 'partial' end, \
         paid_at = case when (coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)) <= 0.005 then now() else null end, \
         updated_at = $2::timestamp where id = $3"
    } else {
        "update bills set \
         amount_paid = (coalesce(amount_paid, '0')::numeric + $1::numeric), \
         balance_due = greatest((coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)), 0), \
         status = case when (coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)) <= 0.005 then 'paid' \
           when (coalesce(amount_paid, '0')::numeric + $1::numeric) <= 0.005 then 'approved' \
           else 'partial' end, \
         paid_at = case when (coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)) <= 0.005 then now() else null end, \
         updated_at = $2::timestamp where id = $3"
    };
    sqlx::query(statement)
        .bind(to_fixed(delta, 2))
        .bind(now())
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
