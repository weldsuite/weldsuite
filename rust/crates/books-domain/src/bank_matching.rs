//! Matching bank statement lines to the books (`accounting-reconciliation`,
//! `accounting-bank-match`, `accounting-bank-similarity`): suggestions for a
//! line (open invoices and bills, payments not yet tied to a bank line,
//! deposits), the automatic matcher over an account's open lines, tying a
//! line to an invoice or bill (a new payment), a payment or a deposit, and
//! undoing a match.
//!
//! The banking routes and the bank feeds (a sync runs the matcher over the
//! lines it brought in) share it. Rows are `Value`s as Drizzle returns them
//! (`<TABLE>.js(row)`); floating-point sums run in the worker's order, so the
//! confidences come out bit for bit.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_ports::OutboundHttp;

use crate::document_posting::{owned, text, update_with_entry};
use crate::http::now;
use crate::js::{
    js_date_millis, math_round, millis_of, number_text, parse_float, round_money, to_fixed,
};
use crate::payments::{
    AllocationInput, RecordPaymentInput, payment_net_amount, record_payment, void_payment,
};
use crate::posting::{PostError, ReverseArgs, reverse_journal_entry};
use crate::tables::{BANK_DEPOSITS, BANK_TRANSACTIONS, BILLS, INVOICES, PAYMENTS};

/// `reconciliation_type` of a line linked to a payment recorded earlier.
pub const PAYMENT_LINK: &str = "payment_link";
/// `reconciliation_type` of a line linked to a bank deposit.
pub const DEPOSIT_LINK: &str = "deposit";

fn posting(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

// ── Names ───────────────────────────────────────────────────────────────────

const LEGAL_SUFFIXES: &[&str] = &[
    "inc",
    "incorporated",
    "llc",
    "llp",
    "lp",
    "ltd",
    "limited",
    "corp",
    "corporation",
    "co",
    "company",
    "plc",
    "pllc",
    "pc",
    "bv",
    "nv",
    "gmbh",
    "ag",
    "sa",
    "sarl",
    "the",
    "and",
    "of",
    "dba",
];

const BANK_NOISE: &[&str] = &[
    "ach",
    "credit",
    "debit",
    "cr",
    "dr",
    "pmt",
    "pymt",
    "payment",
    "payments",
    "deposit",
    "dep",
    "web",
    "ppd",
    "ccd",
    "ctx",
    "online",
    "onl",
    "transfer",
    "xfer",
    "wire",
    "incoming",
    "outgoing",
    "from",
    "to",
    "ref",
    "reference",
    "id",
    "check",
    "chk",
    "pos",
    "purchase",
    "card",
    "recurring",
    "preauthorized",
    "preauth",
    "remote",
    "mobile",
    "bill",
    "pay",
    "trn",
    "trace",
    "orig",
    "co",
    "name",
    "inv",
    "invoice",
    "no",
    "num",
    "number",
    "for",
    "thank",
    "you",
];

/// `nameTokens(value, { dropNoise })`: lower-case tokens without
/// punctuation, bare numbers, legal suffixes (and the bank's own words).
pub fn name_tokens(value: Option<&str>, drop_noise: bool) -> Vec<String> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Vec::new();
    };
    let lower = value.to_lowercase().replace('&', " and ");
    let cleaned: String = lower
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || crate::jurisdictions::is_js_space(c)
            {
                c
            } else {
                ' '
            }
        })
        .collect();
    cleaned
        .split(crate::jurisdictions::is_js_space)
        .filter(|t| !t.is_empty())
        .filter(|t| !t.bytes().all(|b| b.is_ascii_digit()))
        .filter(|t| !LEGAL_SUFFIXES.contains(t))
        .filter(|t| !(drop_noise && BANK_NOISE.contains(t)))
        .map(str::to_owned)
        .collect()
}

/// `tokensMatch`: equal, or the longer starts with the shorter (4+ letters).
fn tokens_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    short.len() >= 4 && long.starts_with(short)
}

#[allow(clippy::cast_precision_loss)]
fn coverage(needles: &[String], haystack: &[String]) -> f64 {
    if needles.is_empty() {
        return 0.0;
    }
    let found = needles
        .iter()
        .filter(|n| haystack.iter().any(|h| tokens_match(n, h)))
        .count();
    found as f64 / needles.len() as f64
}

/// `nameSimilarity(line, contactName)`: how well a bank line names a
/// contact, 0 to 1.
pub fn name_similarity(
    counterparty_name: Option<&str>,
    description: Option<&str>,
    contact_name: Option<&str>,
) -> f64 {
    let contact = name_tokens(contact_name, false);
    if contact.is_empty() {
        return 0.0;
    }
    let mut best = 0.0;
    let counterparty = name_tokens(counterparty_name, true);
    if !counterparty.is_empty() {
        // `(a + b) / 2`, as the worker averages.
        #[allow(clippy::manual_midpoint)]
        {
            best = (coverage(&contact, &counterparty) + coverage(&counterparty, &contact)) / 2.0;
        }
    }
    let described = name_tokens(description, true);
    if !described.is_empty() {
        let held = coverage(&contact, &described);
        let weight = if contact.len() == 1 && described.len() > 4 {
            0.7
        } else {
            0.9
        };
        best = f64::max(best, held * weight);
    }
    math_round(best * 100.0) / 100.0
}

/// `nameConfidence(similarity)`.
pub fn name_confidence(similarity: f64) -> Option<(f64, &'static str)> {
    if similarity >= 0.8 {
        Some((0.3, "name matches"))
    } else if similarity >= 0.5 {
        Some((0.15, "name partly matches"))
    } else {
        None
    }
}

/// `daysApart(a, b)`: days between two dates (ISO text), ignoring the time
/// of day.
pub fn days_apart(a: &str, b: &str) -> i64 {
    let day = |v: &str| {
        js_date_millis(v)
            .or_else(|| millis_of(v))
            .map_or(i64::MIN / 2, |ms| ms.div_euclid(86_400_000))
    };
    (day(a) - day(b)).abs()
}

// ── Candidates ──────────────────────────────────────────────────────────────

/// What matching reads of a bank line (`MatchableTransaction`): the row.
#[derive(Debug, Clone)]
pub struct Line<'a>(pub &'a Value);

impl Line<'_> {
    fn text(&self, key: &str) -> Option<&str> {
        text(self.0, key)
    }

    /// `x || ''`-style read where the row has a value that may be empty.
    fn filled(&self, key: &str) -> Option<&str> {
        self.text(key).filter(|v| !v.is_empty())
    }
}

/// `MatchCandidates`.
#[derive(Debug, Clone, Default)]
pub struct Candidates {
    pub invoices: Vec<Value>,
    pub bills: Vec<Value>,
    pub payments: Vec<Value>,
    pub deposits: Vec<Value>,
    /// `id → (name, iban)`.
    pub contacts: Vec<(String, Option<String>, Option<String>)>,
}

impl Candidates {
    fn contact(&self, id: Option<&str>) -> Option<&(String, Option<String>, Option<String>)> {
        let id = id?;
        self.contacts.iter().find(|(c, _, _)| c == id)
    }
}

/// `amountBounds`: within 2% of the amount.
fn amount_bounds(abs_amount: f64) -> (String, String) {
    (
        number_text(f64::max(abs_amount * 0.98 - 0.01, 0.0)),
        number_text(abs_amount * 1.02 + 0.01),
    )
}

/// `loadMatchCandidates(db, args)`: the open invoices and bills, unlinked
/// payments and unmatched deposits a line could belong to; with `amount`
/// only the ones near it.
pub async fn load_candidates(
    db: &PgPool,
    entity_id: Option<&str>,
    bank_account_id: Option<&str>,
    amount: Option<f64>,
    check_number: Option<&str>,
) -> Result<Candidates, sqlx::Error> {
    let limit: i64 = 5000;
    let (low, high) = amount.map(amount_bounds).unzip();
    let entity_id = entity_id.filter(|id| !id.is_empty());
    let invoices: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(invoices),
        " from invoices t where t.status = any(array['sent','finalized','partial','overdue']) \
         and t.deleted_at is null and ($1::text is null or t.entity_id = $1) \
         and ($2::text is null or t.balance_due::numeric between $2::numeric and $3::numeric) limit $4"
    ))
    .bind(entity_id)
    .bind(low.as_deref())
    .bind(high.as_deref())
    .bind(limit)
    .fetch_all(db)
    .await?;
    let bills: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bills),
        " from bills t where t.status = any(array['approved','partial','overdue']) \
         and t.deleted_at is null and ($1::text is null or t.entity_id = $1) \
         and ($2::text is null or t.balance_due::numeric between $2::numeric and $3::numeric) limit $4"
    ))
    .bind(entity_id)
    .bind(low.as_deref())
    .bind(high.as_deref())
    .bind(limit)
    .fetch_all(db)
    .await?;
    let payments: Vec<Value> = match entity_id {
        Some(entity) => {
            sqlx::query_scalar(concat!(
                "select ",
                crate::books_row!(payments),
                " from payments t where t.entity_id = $1 and t.deleted_at is null \
                 and t.bank_transaction_id is null and t.deposit_id is null \
                 and ($2::text is null or (t.amount::numeric - coalesce(t.backup_withholding_amount::numeric, 0)) \
                 between $2::numeric and $3::numeric or ($4::text is not null and t.check_number = $4)) limit $5"
            ))
            .bind(entity)
            .bind(low.as_deref())
            .bind(high.as_deref())
            .bind(check_number.filter(|c| !c.is_empty()).filter(|_| low.is_some()))
            .bind(limit)
            .fetch_all(db)
            .await?
        }
        None => Vec::new(),
    };
    let deposits: Vec<Value> = match (entity_id, bank_account_id.filter(|id| !id.is_empty())) {
        (Some(entity), Some(account)) => {
            sqlx::query_scalar(concat!(
                "select ",
                crate::books_row!(bank_deposits),
                " from bank_deposits t where t.entity_id = $1 and t.bank_account_id = $2 \
                 and t.status = 'posted' and t.deleted_at is null and t.bank_transaction_id is null \
                 and ($3::text is null or t.amount::numeric between $3::numeric and $4::numeric) limit $5"
            ))
            .bind(entity)
            .bind(account)
            .bind(low.as_deref())
            .bind(high.as_deref())
            .bind(limit)
            .fetch_all(db)
            .await?
        }
        _ => Vec::new(),
    };
    let invoices = INVOICES.js_rows(invoices);
    let bills = BILLS.js_rows(bills);
    let payments = PAYMENTS.js_rows(payments);
    let deposits = BANK_DEPOSITS.js_rows(deposits);

    let mut contact_ids: Vec<String> = Vec::new();
    for row in invoices.iter().chain(&bills).chain(&payments) {
        if let Some(id) = text(row, "contactId").filter(|id| !id.is_empty())
            && !contact_ids.iter().any(|c| c == id)
        {
            contact_ids.push(id.to_owned());
        }
    }
    let contacts: Vec<(String, Option<String>, Option<String>)> = if contact_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, display_name, iban from parties where id = any($1)")
            .bind(&contact_ids)
            .fetch_all(db)
            .await?
    };
    Ok(Candidates {
        invoices,
        bills,
        payments,
        deposits,
        contacts,
    })
}

// ── Suggestions ─────────────────────────────────────────────────────────────

/// `ReconciliationSuggestion`.
#[derive(Debug, Clone, PartialEq)]
pub struct Suggestion {
    /// `invoice`, `bill`, `payment` or `deposit`.
    pub kind: &'static str,
    pub entity_id: String,
    pub entity_number: Option<String>,
    pub contact_name: Option<String>,
    pub amount: String,
    pub confidence: f64,
    pub reasons: Vec<String>,
}

impl Suggestion {
    /// The suggestion as the matcher returns it (`{ type, entityId, …,
    /// reason, reasons }`).
    pub fn to_json(&self) -> Value {
        json!({
            "type": self.kind,
            "entityId": self.entity_id,
            "entityNumber": self.entity_number,
            "contactName": self.contact_name,
            "amount": self.amount,
            "confidence": crate::js::number_value(self.confidence),
            "reason": self.reasons.join(", "),
            "reasons": self.reasons,
        })
    }
}

fn suggestion(
    kind: &'static str,
    entity_id: &str,
    entity_number: Option<String>,
    contact_name: Option<String>,
    amount: String,
    confidence: f64,
    reasons: Vec<String>,
) -> Suggestion {
    Suggestion {
        kind,
        entity_id: entity_id.to_owned(),
        entity_number,
        contact_name,
        amount,
        confidence: confidence.clamp(0.0, 1.0),
        reasons,
    }
}

/// `scoreAmountMatch(balanceDue, absAmount)`.
fn score_amount(balance_due: f64, abs_amount: f64) -> Option<(f64, &'static str)> {
    if (balance_due - abs_amount).abs() < 0.01 {
        return Some((0.4, "exact amount match"));
    }
    if (balance_due - abs_amount).abs() / abs_amount < 0.02 {
        return Some((0.2, "close amount match"));
    }
    None
}

/// `nameMatch(transaction, contactName)`.
fn name_match(line: &Line<'_>, contact_name: Option<&str>) -> Option<(f64, &'static str)> {
    // `description ?? reference`
    let description = line.text("description").or_else(|| line.text("reference"));
    name_confidence(name_similarity(
        line.text("counterpartyName"),
        description,
        contact_name,
    ))
}

/// `paymentWindow(txnDate, issueDate, dueDate)`.
fn payment_window(
    line_date: Option<&str>,
    issue: Option<&str>,
    due: Option<&str>,
) -> Option<(f64, &'static str)> {
    let when = millis_of(line_date?)?;
    let issued = millis_of(issue?)?;
    if when < issued - 3 * 86_400_000 {
        return Some((-0.1, "dated before the document"));
    }
    let end = due.and_then(millis_of).unwrap_or(issued) + 60 * 86_400_000;
    (when <= end).then_some((0.05, "inside the payment window"))
}

fn parse_amount(row: &Value, key: &str) -> f64 {
    parse_float(text(row, key).filter(|v| !v.is_empty()).unwrap_or("0"))
}

fn match_documents(
    pool: &Candidates,
    abs_amount: f64,
    line: &Line<'_>,
    invoice: bool,
) -> Vec<Suggestion> {
    let rows = if invoice { &pool.invoices } else { &pool.bills };
    let entity = line.filled("entityId");
    let mut out = Vec::new();
    for doc in rows {
        if entity.is_some() && text(doc, "entityId") != entity {
            continue;
        }
        let balance = parse_amount(doc, "balanceDue");
        let Some((mut confidence, reason)) = score_amount(balance, abs_amount) else {
            continue;
        };
        let mut reasons = vec![reason.to_owned()];
        let reference = line
            .filled("reference")
            .or_else(|| line.filled("description"))
            .unwrap_or_default();
        if invoice {
            let number = text(doc, "invoiceNumber").filter(|n| !n.is_empty());
            if let Some(number) = number
                && reference.contains(number)
            {
                confidence += 0.4;
                reasons.push("invoice number in reference".to_owned());
            }
            if let (Some(e2e), Some(number)) = (line.filled("endToEndId"), number)
                && e2e.contains(number)
            {
                confidence += 0.3;
                reasons.push("invoice number in end-to-end ID".to_owned());
            }
        } else if let Some(external) = text(doc, "externalReference").filter(|r| !r.is_empty())
            && reference.contains(external)
        {
            confidence += 0.4;
            reasons.push("external reference in description".to_owned());
        }
        let contact = pool.contact(text(doc, "contactId"));
        if let (Some(iban), Some(contact_iban)) = (
            line.filled("counterpartyIban"),
            contact
                .and_then(|c| c.2.as_deref())
                .filter(|i| !i.is_empty()),
        ) && contact_iban == iban
        {
            confidence += 0.3;
            reasons.push(format!(
                "counterparty IBAN matches {}",
                if invoice { "contact" } else { "vendor" }
            ));
        }
        let contact_name = text(doc, "contactName")
            .map(str::to_owned)
            .or_else(|| contact.and_then(|c| c.1.clone()));
        if let Some((boost, reason)) = name_match(line, contact_name.as_deref()) {
            confidence += boost;
            reasons.push(format!(
                "{reason} the {}",
                if invoice { "customer" } else { "vendor" }
            ));
        }
        if let Some((boost, reason)) = payment_window(
            line.text("date"),
            text(doc, "issueDate"),
            text(doc, "dueDate"),
        ) {
            confidence += boost;
            reasons.push(reason.to_owned());
        }
        if confidence > 0.0 {
            let number = text(
                doc,
                if invoice {
                    "invoiceNumber"
                } else {
                    "billNumber"
                },
            )
            .map(str::to_owned);
            let amount = text(doc, "balanceDue")
                .filter(|v| !v.is_empty())
                .unwrap_or("0")
                .to_owned();
            out.push(suggestion(
                if invoice { "invoice" } else { "bill" },
                text(doc, "id").unwrap_or_default(),
                number,
                contact_name,
                amount,
                confidence,
                reasons,
            ));
        }
    }
    out
}

/// `normalizeCheckNumber`: no spaces or leading zeros, lower-case.
fn normalize_check(value: Option<&str>) -> String {
    let compact: String = value
        .unwrap_or_default()
        .chars()
        .filter(|c| !crate::jurisdictions::is_js_space(*c))
        .collect();
    let zeros = compact.bytes().take_while(|b| *b == b'0').count();
    let drop = if zeros == 0 {
        0
    } else if compact
        .as_bytes()
        .get(zeros)
        .is_some_and(u8::is_ascii_digit)
    {
        zeros
    } else {
        zeros - 1
    };
    compact[drop..].to_lowercase()
}

fn match_payments(
    pool: &Candidates,
    line: &Line<'_>,
    abs_amount: f64,
    received: bool,
) -> Vec<Suggestion> {
    let Some(entity) = line.filled("entityId") else {
        return Vec::new();
    };
    let check = normalize_check(line.text("checkNumber"));
    let direction = if received { "received" } else { "sent" };
    let mut out = Vec::new();
    for payment in &pool.payments {
        if text(payment, "type") != Some(direction) || text(payment, "entityId") != Some(entity) {
            continue;
        }
        let bank_amount = payment_net_amount(payment);
        let withheld = parse_float(text(payment, "backupWithholdingAmount").unwrap_or("0")) > 0.0;
        let amount_matches = (bank_amount - abs_amount).abs() < 0.01;
        let check_matches =
            !check.is_empty() && normalize_check(text(payment, "checkNumber")) == check;
        if !amount_matches && !check_matches {
            continue;
        }
        let mut reasons = Vec::new();
        let mut confidence = 0.0;
        if amount_matches {
            confidence += 0.4;
            reasons.push(
                if withheld {
                    "exact amount match after backup withholding"
                } else {
                    "exact amount match"
                }
                .to_owned(),
            );
        }
        if check_matches {
            confidence += if amount_matches { 0.5 } else { 0.3 };
            reasons.push(
                if amount_matches {
                    "check number matches"
                } else {
                    "check number matches but the amount differs"
                }
                .to_owned(),
            );
        }
        let contact_name = pool
            .contact(text(payment, "contactId"))
            .and_then(|c| c.1.clone());
        if let Some((boost, reason)) = name_match(line, contact_name.as_deref()) {
            confidence += boost;
            reasons.push(format!("{reason} the payment's contact"));
        }
        if let (Some(date), Some(paid)) = (line.filled("date"), text(payment, "date")) {
            let gap = days_apart(date, paid);
            if gap <= 30 {
                confidence += 0.1;
                reasons.push("dates within 30 days".to_owned());
            } else if gap > 90 {
                confidence -= 0.1;
            }
        }
        if !check_matches {
            confidence = f64::min(confidence, 0.75);
        }
        if confidence > 0.0 {
            let number = owned(payment, "checkNumber").or_else(|| owned(payment, "reference"));
            out.push(suggestion(
                "payment",
                text(payment, "id").unwrap_or_default(),
                number,
                contact_name,
                to_fixed(bank_amount, 2),
                confidence,
                reasons,
            ));
        }
    }
    out
}

fn match_deposits(pool: &Candidates, line: &Line<'_>, abs_amount: f64) -> Vec<Suggestion> {
    let (Some(entity), Some(account)) = (line.filled("entityId"), line.filled("bankAccountId"))
    else {
        return Vec::new();
    };
    pool.deposits
        .iter()
        .filter(|d| {
            text(d, "entityId") == Some(entity)
                && text(d, "bankAccountId") == Some(account)
                && (parse_amount(d, "amount") - abs_amount).abs() < 0.01
        })
        .map(|deposit| {
            let mut reasons = vec!["deposit total matches".to_owned()];
            let mut confidence = 0.6;
            if let (Some(date), Some(made)) = (line.filled("date"), text(deposit, "date"))
                && days_apart(date, made) <= 7
            {
                confidence += 0.15;
                reasons.push("deposit dated within a week".to_owned());
            }
            suggestion(
                "deposit",
                text(deposit, "id").unwrap_or_default(),
                owned(deposit, "memo"),
                None,
                text(deposit, "amount").unwrap_or_default().to_owned(),
                confidence,
                reasons,
            )
        })
        .collect()
}

/// `findMatches(db, schema, transaction, candidates)`: the suggestions for
/// a line, most confident first; `pool` matches many lines against one
/// load.
pub async fn find_matches(
    db: &PgPool,
    line: &Value,
    pool: Option<&Candidates>,
) -> Result<Vec<Suggestion>, sqlx::Error> {
    let line = Line(line);
    let amount = parse_float(line.filled("amount").unwrap_or("0"));
    if amount == 0.0 || amount.is_nan() {
        return Ok(Vec::new());
    }
    let abs_amount = amount.abs();
    let loaded;
    let pool = if let Some(pool) = pool {
        pool
    } else {
        loaded = load_candidates(
            db,
            line.text("entityId"),
            line.text("bankAccountId"),
            Some(abs_amount),
            line.text("checkNumber"),
        )
        .await?;
        &loaded
    };
    let mut suggestions = if amount > 0.0 {
        let mut out = match_documents(pool, abs_amount, &line, true);
        out.extend(match_payments(pool, &line, abs_amount, true));
        out.extend(match_deposits(pool, &line, abs_amount));
        out
    } else {
        let mut out = match_documents(pool, abs_amount, &line, false);
        out.extend(match_payments(pool, &line, abs_amount, false));
        out
    };
    suggestions.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(suggestions)
}

// ── Tying a line to the books ───────────────────────────────────────────────

/// What a match recorded or linked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Matched {
    pub id: String,
    pub journal_entry_id: Option<String>,
}

/// A document lookup: id, entity, contact, open balance.
type DocumentRow = (String, Option<String>, Option<String>, Option<String>);

/// `reconcileBankTransactionToDocument`: a new payment (money in against
/// an invoice, out against a bill), posted, settling the document and the
/// line in one go. (`!(amount > 0)` keeps JavaScript's NaN handling.)
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub async fn reconcile_to_document(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    txn: &Value,
    invoice: bool,
    document_id: &str,
    reconciliation_type: Option<&str>,
    user_id: Option<String>,
) -> Result<Matched, PostError> {
    if text(txn, "status") != Some("unreconciled") {
        return Err(posting("Transaction is already reconciled or excluded"));
    }
    let amount = parse_float(text(txn, "amount").unwrap_or("0"));
    if invoice && !(amount > 0.0) {
        return Err(posting("Only money coming in can be matched to an invoice"));
    }
    if !invoice && !(amount < 0.0) {
        return Err(posting("Only money going out can be matched to a bill"));
    }
    let doc: Option<DocumentRow> = if invoice {
        sqlx::query_as(
            "select id, entity_id, contact_id, balance_due::text from invoices where id = $1 and deleted_at is null limit 1",
        )
    } else {
        sqlx::query_as(
            "select id, entity_id, contact_id, balance_due::text from bills where id = $1 and deleted_at is null limit 1",
        )
    }
    .bind(document_id)
    .fetch_optional(db)
    .await?;
    let Some((doc_id, doc_entity, contact_id, balance_due)) = doc else {
        return Err(posting(if invoice {
            "Invoice not found"
        } else {
            "Bill not found"
        }));
    };
    if doc_entity.as_deref() != text(txn, "entityId") {
        return Err(posting(format!(
            "Linked {} belongs to a different accounting entity",
            if invoice { "invoice" } else { "bill" }
        )));
    }
    let currency: Option<Option<String>> =
        sqlx::query_scalar("select currency from bank_accounts where id = $1 limit 1")
            .bind(text(txn, "bankAccountId"))
            .fetch_optional(db)
            .await?;
    let paid = round_money(amount.abs());
    let allocated = round_money(f64::min(
        paid,
        parse_float(balance_due.as_deref().unwrap_or("0")),
    ));
    let check_number = owned(txn, "checkNumber");
    let has_check = check_number.as_deref().is_some_and(|c| !c.is_empty());
    let result = record_payment(
        db,
        http,
        RecordPaymentInput {
            entity_id: text(txn, "entityId").unwrap_or_default().to_owned(),
            received: invoice,
            amount: paid,
            currency: currency.flatten(),
            date: text(txn, "date").unwrap_or_default().to_owned(),
            payment_method: Some(if has_check { "check" } else { "bank_transfer" }.to_owned()),
            check_number: check_number.clone(),
            check_status: (!invoice && has_check).then(|| "cleared".to_owned()),
            reference: owned(txn, "reference")
                .or_else(|| owned(txn, "endToEndId"))
                .or_else(|| owned(txn, "description")),
            contact_id,
            bank_account_id: owned(txn, "bankAccountId"),
            bank_transaction_id: owned(txn, "id"),
            deposit_to: Some("bank".to_owned()),
            reconciliation_type: Some(reconciliation_type.unwrap_or("manual").to_owned()),
            allocations: if allocated > 0.0 {
                vec![AllocationInput {
                    invoice_id: invoice.then(|| doc_id.clone()),
                    bill_id: (!invoice).then(|| doc_id.clone()),
                    amount: allocated,
                }]
            } else {
                Vec::new()
            },
            user_id,
            ..RecordPaymentInput::default()
        },
    )
    .await?;
    Ok(Matched {
        id: result.payment_id,
        journal_entry_id: result.journal_entry_id,
    })
}

/// `reconcileBankTransactionToPayment`: tie a line to a payment recorded
/// before it arrived; only links (a printed check becomes cleared).
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub async fn reconcile_to_payment(
    db: &PgPool,
    txn: &Value,
    payment_id: &str,
) -> Result<Matched, PostError> {
    if text(txn, "status") != Some("unreconciled") {
        return Err(posting("Transaction is already reconciled or excluded"));
    }
    let payment: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(payments),
        " from payments t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(payment_id)
    .fetch_optional(db)
    .await?;
    let Some(payment) = payment.map(|row| PAYMENTS.js(row)) else {
        return Err(posting("Payment not found"));
    };
    if text(&payment, "entityId") != text(txn, "entityId") {
        return Err(posting(
            "The payment belongs to a different accounting entity",
        ));
    }
    if text(&payment, "bankTransactionId").is_some_and(|v| !v.is_empty()) {
        return Err(posting("This payment is already matched to a bank line"));
    }
    if text(&payment, "depositId").is_some_and(|v| !v.is_empty()) {
        return Err(posting(
            "This payment is part of a bank deposit. Match the deposit to the bank line instead.",
        ));
    }
    let amount = parse_float(text(txn, "amount").unwrap_or("0"));
    let received = text(&payment, "type") == Some("received");
    if if received {
        !(amount > 0.0)
    } else {
        !(amount < 0.0)
    } {
        return Err(posting(if received {
            "Only money coming in can be matched to a payment received"
        } else {
            "Only money going out can be matched to a payment sent"
        }));
    }
    let bank_amount = payment_net_amount(&payment);
    if (round_money(amount.abs()) - bank_amount).abs() >= 0.005 {
        let withheld = parse_float(text(&payment, "backupWithholdingAmount").unwrap_or("0"));
        let gross = parse_float(text(&payment, "amount").unwrap_or_default());
        return Err(posting(if withheld > 0.0 {
            format!(
                "The payment is for {} ({} less {} backup withholding) but the bank line is {}.",
                to_fixed(bank_amount, 2),
                to_fixed(gross, 2),
                to_fixed(withheld, 2),
                to_fixed(amount.abs(), 2)
            )
        } else {
            format!(
                "The payment is for {} but the bank line is {}.",
                to_fixed(bank_amount, 2),
                to_fixed(amount.abs(), 2)
            )
        }));
    }
    let stamp = now();
    let clears_check = text(&payment, "paymentMethod") == Some("check")
        && text(&payment, "checkStatus") == Some("printed");
    let mut tx = db.begin().await?;
    sqlx::query(
        "update bank_transactions set status = 'reconciled', reconciliation_type = $2, \
         reconciled_payment_id = $3, reconciled_invoice_id = $4, reconciled_bill_id = $5, \
         journal_entry_id = $6, contact_id = $7, updated_at = $8::timestamp \
         where id = $1 and status = 'unreconciled'",
    )
    .bind(text(txn, "id"))
    .bind(PAYMENT_LINK)
    .bind(text(&payment, "id"))
    .bind(text(&payment, "invoiceId"))
    .bind(text(&payment, "billId"))
    .bind(text(&payment, "journalEntryId"))
    .bind(text(&payment, "contactId"))
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update payments set bank_transaction_id = $2, \
         check_status = case when $3 then 'cleared' else check_status end, updated_at = $4::timestamp \
         where id = $1 and bank_transaction_id is null",
    )
    .bind(text(&payment, "id"))
    .bind(text(txn, "id"))
    .bind(clears_check)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Matched {
        id: text(&payment, "id").unwrap_or_default().to_owned(),
        journal_entry_id: owned(&payment, "journalEntryId"),
    })
}

/// `reconcileBankTransactionToDeposit`: tie an incoming line to the bank
/// deposit it came from; only links.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub async fn reconcile_to_deposit(
    db: &PgPool,
    txn: &Value,
    deposit_id: &str,
) -> Result<Matched, PostError> {
    if text(txn, "status") != Some("unreconciled") {
        return Err(posting("Transaction is already reconciled or excluded"));
    }
    let amount = parse_float(text(txn, "amount").unwrap_or("0"));
    if !(amount > 0.0) {
        return Err(posting("Only money coming in can be matched to a deposit"));
    }
    let deposit: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bank_deposits),
        " from bank_deposits t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(deposit_id)
    .fetch_optional(db)
    .await?;
    let Some(deposit) = deposit.map(|row| BANK_DEPOSITS.js(row)) else {
        return Err(posting("Deposit not found"));
    };
    if text(&deposit, "entityId") != text(txn, "entityId") {
        return Err(posting(
            "The deposit belongs to a different accounting entity",
        ));
    }
    if text(&deposit, "status") != Some("posted") {
        return Err(posting("This deposit has been voided"));
    }
    if text(&deposit, "bankTransactionId").is_some_and(|v| !v.is_empty()) {
        return Err(posting("This deposit is already matched to a bank line"));
    }
    if text(&deposit, "bankAccountId") != text(txn, "bankAccountId") {
        return Err(posting(
            "The deposit was made to a different bank account than the bank line",
        ));
    }
    let deposit_amount = parse_float(text(&deposit, "amount").unwrap_or_default());
    if (round_money(amount) - round_money(deposit_amount)).abs() >= 0.005 {
        return Err(posting(format!(
            "The deposit is for {} but the bank line is {}.",
            to_fixed(deposit_amount, 2),
            to_fixed(amount, 2)
        )));
    }
    let stamp = now();
    let mut tx = db.begin().await?;
    sqlx::query(
        "update bank_transactions set status = 'reconciled', reconciliation_type = $2, deposit_id = $3, \
         journal_entry_id = $4, updated_at = $5::timestamp where id = $1 and status = 'unreconciled'",
    )
    .bind(text(txn, "id"))
    .bind(DEPOSIT_LINK)
    .bind(text(&deposit, "id"))
    .bind(text(&deposit, "journalEntryId"))
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update bank_deposits set bank_transaction_id = $2, updated_at = $3::timestamp \
         where id = $1 and bank_transaction_id is null",
    )
    .bind(text(&deposit, "id"))
    .bind(text(txn, "id"))
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Matched {
        id: text(&deposit, "id").unwrap_or_default().to_owned(),
        journal_entry_id: owned(&deposit, "journalEntryId"),
    })
}

/// The columns `unreconcileBankTransaction` resets.
fn reset_values(stamp: &str) -> Map<String, Value> {
    let mut set = Map::new();
    set.insert("status".to_owned(), json!("unreconciled"));
    for key in [
        "reconciliationType",
        "reconciledInvoiceId",
        "reconciledBillId",
        "reconciledPaymentId",
        "journalEntryId",
        "categoryAccountId",
        "depositId",
    ] {
        set.insert(key.to_owned(), Value::Null);
    }
    set.insert("updatedAt".to_owned(), json!(stamp));
    set
}

/// `unreconcileBankTransaction`: void the payment the match created, reverse
/// the entry a categorization posted, or unlink a payment or deposit.
pub async fn unreconcile(
    db: &PgPool,
    txn: &Value,
    user_id: Option<String>,
) -> Result<(), PostError> {
    if text(txn, "status") == Some("unreconciled") {
        return Err(posting("Transaction is not reconciled"));
    }
    let stamp = now();
    let id = text(txn, "id").unwrap_or_default().to_owned();
    let reset = reset_values(&stamp);
    let kind = text(txn, "reconciliationType");
    let filled = |key: &str| text(txn, key).filter(|v| !v.is_empty());

    if kind == Some(PAYMENT_LINK)
        && let Some(payment_id) = filled("reconciledPaymentId")
    {
        let payment: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, payment_method, check_status from payments where id = $1 limit 1",
        )
        .bind(payment_id)
        .fetch_optional(db)
        .await?;
        let mut tx = db.begin().await?;
        BANK_TRANSACTIONS
            .patch_raw(&mut *tx, &id, BANK_TRANSACTIONS.values(&reset), false)
            .await?;
        if let Some((payment, method, status)) = payment {
            let unclear =
                method.as_deref() == Some("check") && status.as_deref() == Some("cleared");
            sqlx::query(
                "update payments set bank_transaction_id = null, \
                 check_status = case when $2 then 'printed' else check_status end, updated_at = $3::timestamp where id = $1",
            )
            .bind(&payment)
            .bind(unclear)
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        return Ok(());
    }
    if kind == Some(DEPOSIT_LINK)
        && let Some(deposit_id) = filled("depositId")
    {
        let mut tx = db.begin().await?;
        BANK_TRANSACTIONS
            .patch_raw(&mut *tx, &id, BANK_TRANSACTIONS.values(&reset), false)
            .await?;
        sqlx::query("update bank_deposits set bank_transaction_id = null, updated_at = $2::timestamp where id = $1")
            .bind(deposit_id)
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(());
    }
    if let Some(payment_id) = filled("reconciledPaymentId") {
        void_payment(db, payment_id, user_id, Some(stamp)).await?;
        return Ok(());
    }
    if let Some(entry_id) = filled("journalEntryId") {
        let description = format!("Undo bank line {}", text(txn, "description").unwrap_or(&id));
        reverse_journal_entry(
            db,
            ReverseArgs {
                entry_id: entry_id.to_owned(),
                date: stamp,
                created_by: user_id,
                description: Some(description),
                also_write: vec![update_with_entry(&BANK_TRANSACTIONS, id, reset, None)],
                ..ReverseArgs::default()
            },
        )
        .await?;
        return Ok(());
    }
    BANK_TRANSACTIONS
        .patch_raw(db, &id, BANK_TRANSACTIONS.values(&reset), false)
        .await?;
    Ok(())
}

// ── The automatic matcher ───────────────────────────────────────────────────

/// One line's outcome (`ReconciliationResult`).
#[derive(Debug, Clone)]
pub struct AutoResult {
    pub transaction_id: String,
    pub suggestions: Vec<Suggestion>,
    pub reconciled: Option<(&'static str, String)>,
}

impl AutoResult {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("transactionId".to_owned(), json!(self.transaction_id));
        out.insert(
            "suggestions".to_owned(),
            Value::Array(self.suggestions.iter().map(Suggestion::to_json).collect()),
        );
        out.insert(
            "autoReconciled".to_owned(),
            json!(self.reconciled.is_some()),
        );
        if let Some((kind, id)) = &self.reconciled {
            out.insert("reconciledEntityType".to_owned(), json!(kind));
            out.insert("reconciledEntityId".to_owned(), json!(id));
        }
        Value::Object(out)
    }
}

/// `autoReconcileBatch(db, schema, bankAccountId, userId)`: match an
/// account's unreconciled lines (up to 200); an invoice, bill or payment
/// match at 0.8 or more is recorded, one that can't be posted stays a
/// suggestion.
pub async fn auto_reconcile_batch(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    bank_account_id: &str,
    user_id: Option<&str>,
) -> Result<(usize, Vec<AutoResult>), sqlx::Error> {
    let lines: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bank_transactions),
        " from bank_transactions t where t.bank_account_id = $1 and t.status = 'unreconciled' \
         and t.deleted_at is null limit 200"
    ))
    .bind(bank_account_id)
    .fetch_all(db)
    .await?;
    let lines = BANK_TRANSACTIONS.js_rows(lines);
    let mut results = Vec::new();
    let mut count = 0;
    let Some(first) = lines.first() else {
        return Ok((count, results));
    };
    let mut pool = load_candidates(
        db,
        text(first, "entityId"),
        Some(bank_account_id),
        None,
        None,
    )
    .await?;
    for txn in &lines {
        let suggestions = find_matches(db, txn, Some(&pool)).await?;
        let auto = suggestions
            .first()
            .filter(|s| s.confidence >= 0.8 && matches!(s.kind, "invoice" | "bill" | "payment"))
            .cloned();
        let mut result = AutoResult {
            transaction_id: text(txn, "id").unwrap_or_default().to_owned(),
            suggestions,
            reconciled: None,
        };
        if let Some(auto) = auto {
            let outcome = if auto.kind == "payment" {
                reconcile_to_payment(db, txn, &auto.entity_id).await
            } else {
                reconcile_to_document(
                    db,
                    http,
                    txn,
                    auto.kind == "invoice",
                    &auto.entity_id,
                    Some("auto"),
                    user_id.map(str::to_owned),
                )
                .await
            };
            match outcome {
                Ok(_) => {
                    result.reconciled = Some((auto.kind, auto.entity_id.clone()));
                    count += 1;
                    let used = |row: &Value| text(row, "id") != Some(auto.entity_id.as_str());
                    pool.invoices.retain(used);
                    pool.bills.retain(used);
                    pool.payments.retain(used);
                }
                Err(error) => {
                    tracing::warn!(
                        line = %result.transaction_id,
                        %error,
                        "[auto-reconcile] left as a suggestion"
                    );
                }
            }
        }
        results.push(result);
    }
    Ok((count, results))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_compare_as_token_sets() {
        assert_eq!(
            name_tokens(Some("ACH CREDIT Acme & Sons, Inc. 2001"), true),
            vec!["acme", "sons"]
        );
        assert!(
            (name_similarity(Some("ACME CORP"), None, Some("Acme Corporation Inc")) - 1.0).abs()
                < f64::EPSILON
        );
        assert!(name_similarity(Some("ACME"), None, Some("Acme Roofing")) < 0.8);
        assert_eq!(
            name_similarity(
                None,
                Some("ACH CREDIT ACME CORP INV 2001"),
                Some("Acme Corp")
            ),
            0.9
        );
        assert_eq!(name_confidence(0.5), Some((0.15, "name partly matches")));
    }

    #[test]
    fn check_numbers_and_days() {
        assert_eq!(normalize_check(Some(" 001042 ")), "1042");
        assert_eq!(normalize_check(Some("000")), "0");
        assert_eq!(days_apart("2026-02-01T23:00:00.000Z", "2026-02-03"), 2);
    }
}
