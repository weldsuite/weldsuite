//! Recording and voiding payments (books-api
//! `services/accounting-payments.ts`). A payment can settle several
//! invoices or bills (allocations). Recording one writes the payment, its
//! allocations, the documents' new paid amounts and statuses, the bank-line
//! reconciliation and its journal entry as one atomic posting; a realised FX
//! difference posts separately. Voiding reverses all of that.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use crate::bad_debt::{
    find_recovery_entries, post_bad_debt_recovery, settle_written_off, written_off_balance,
};
use crate::currency::calculate_fx_gain_loss;
use crate::document_posting::{
    PaymentAllocationInput, PaymentPostingInput, amount_of, build_payment_posting, filled, owned,
    settle, text,
};
use crate::entity_context::resolve_entity_base_currency;
use crate::fx::{
    RateQuery, format_rate, is_foreign_currency, missing_rate_message, parse_rate, resolve_rate,
};
use crate::guards::PostingLockKind;
use crate::http::now;
use crate::js::{millis_of, round_money, to_fixed};
use crate::posting::{
    AlsoWrite, PostError, PostJournalEntryInput, PostingLine, ReverseArgs, account_for_role,
    load_entity_accounts, post_journal_entry, reverse_journal_entry,
};
use crate::tables::{BILLS, INVOICES, PAYMENT_ALLOCATIONS, PAYMENTS};

/// `PAYMENT_METHODS`.
pub const PAYMENT_METHODS: [&str; 11] = [
    "check",
    "ach",
    "wire",
    "credit_card",
    "debit_card",
    "cash",
    "third_party_network",
    "bank_transfer",
    "direct_debit",
    "ideal",
    "other",
];

fn posting(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

/// `normalizePaymentMethod(method)`: the method list, older values mapped
/// onto it, anything else `other`.
pub fn normalize_payment_method(method: Option<&str>) -> Option<&'static str> {
    let method = method.filter(|m| !m.is_empty())?;
    let value = crate::jurisdictions::js_trim(method).to_lowercase();
    if let Some(known) = PAYMENT_METHODS.iter().find(|m| **m == value) {
        return Some(known);
    }
    Some(match value.as_str() {
        "card" => "credit_card",
        "bank" | "transfer" => "bank_transfer",
        _ => "other",
    })
}

/// `paymentNetAmount(payment)`: the amount less any backup withholding,
/// what moved through the bank.
pub fn payment_net_amount(payment: &Value) -> f64 {
    round_money(amount_of(payment, "amount") - amount_of(payment, "backupWithholdingAmount"))
}

/// `resolveDepositTarget(input, method, hasUndepositedFunds)`: whether a
/// received payment waits in Undeposited Funds (`true`) or debits the bank.
pub fn deposits_undeposited(
    input: &RecordPaymentInput,
    method: Option<&str>,
    has_undeposited_funds: bool,
) -> Result<bool, PostError> {
    let deposit_to = input.deposit_to.as_deref();
    if !input.received || deposit_to == Some("bank") {
        return Ok(false);
    }
    if !has_undeposited_funds {
        if deposit_to == Some("undeposited_funds") {
            return Err(posting(
                "This accounting entity has no Undeposited Funds account",
            ));
        }
        return Ok(false);
    }
    if deposit_to == Some("undeposited_funds") {
        return Ok(true);
    }
    let filled = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
    if filled(&input.bank_transaction_id) || filled(&input.bank_account_id) {
        return Ok(false);
    }
    Ok(matches!(method, Some("check" | "cash")))
}

/// One allocation of [`RecordPaymentInput`].
#[derive(Debug, Clone, Default)]
pub struct AllocationInput {
    pub invoice_id: Option<String>,
    pub bill_id: Option<String>,
    pub amount: f64,
}

/// `RecordPaymentInput`.
#[derive(Debug, Clone, Default)]
pub struct RecordPaymentInput {
    /// A caller-chosen id, for idempotency.
    pub id: Option<String>,
    pub entity_id: String,
    /// `type === 'received'` (else `sent`).
    pub received: bool,
    pub amount: f64,
    pub currency: Option<String>,
    pub exchange_rate: Option<String>,
    /// The payment date, `toISOString()`.
    pub date: String,
    pub payment_method: Option<String>,
    pub check_number: Option<String>,
    pub check_status: Option<String>,
    /// `undeposited_funds` or `bank`.
    pub deposit_to: Option<String>,
    pub reference: Option<String>,
    pub notes: Option<String>,
    pub contact_id: Option<String>,
    pub bank_account_id: Option<String>,
    pub bank_transaction_id: Option<String>,
    /// `manual` or `auto`.
    pub reconciliation_type: Option<String>,
    pub payment_run_id: Option<String>,
    pub backup_withholding_amount: Option<f64>,
    pub allocations: Vec<AllocationInput>,
    pub user_id: Option<String>,
}

/// `RecordPaymentResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordPaymentResult {
    pub payment_id: String,
    pub journal_entry_id: Option<String>,
    pub contact_id: String,
    pub currency: String,
    /// `(invoice | bill, id)` per allocation.
    pub documents: Vec<(&'static str, String)>,
    /// The money went to Undeposited Funds and still has to be deposited.
    pub undeposited: bool,
}

fn document_ref(invoice_id: Option<&str>, bill_id: Option<&str>) -> (&'static str, String) {
    match invoice_id.filter(|id| !id.is_empty()) {
        Some(id) => ("invoice", id.to_owned()),
        None => ("bill", bill_id.unwrap_or_default().to_owned()),
    }
}

/// `(a.invoiceId ?? a.billId)!`.
fn document_id_of(invoice_id: Option<&str>, bill_id: Option<&str>) -> String {
    invoice_id.or(bill_id).unwrap_or_default().to_owned()
}

/// A loaded invoice or bill (`DocumentRow`), its number under `number`.
struct Document {
    row: Value,
    invoice: bool,
}

impl Document {
    fn number_or_id(&self) -> String {
        text(&self.row, "number")
            .or_else(|| text(&self.row, "id"))
            .unwrap_or_default()
            .to_owned()
    }
}

async fn load_documents(
    db: &PgPool,
    invoice: bool,
    ids: &[String],
) -> Result<Vec<(String, Document)>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = if invoice {
        sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(invoices),
            " from invoices t where t.id = any($1) and t.deleted_at is null"
        ))
        .bind(ids)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(bills),
            " from bills t where t.id = any($1) and t.deleted_at is null"
        ))
        .bind(ids)
        .fetch_all(db)
        .await?
    };
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut row = if invoice {
                INVOICES.js(row)
            } else {
                BILLS.js(row)
            };
            let number = row
                .get(if invoice {
                    "invoiceNumber"
                } else {
                    "billNumber"
                })
                .cloned()
                .unwrap_or(Value::Null);
            if let Some(object) = row.as_object_mut() {
                object.insert("number".to_owned(), number);
            }
            (
                text(&row, "id").unwrap_or_default().to_owned(),
                Document { row, invoice },
            )
        })
        .collect())
}

fn assert_payable(doc: &Document) -> Result<(), PostError> {
    let status = text(&doc.row, "status").unwrap_or_default();
    let number = doc.number_or_id();
    if doc.invoice && status == "draft" {
        return Err(posting(format!(
            "Invoice {number} is a draft. Finalize it before recording a payment."
        )));
    }
    // A written-off ('uncollectible') invoice can still be paid: the write-off is taken back.
    if doc.invoice && status == "cancelled" {
        return Err(posting(format!(
            "Invoice {number} is {status} and can't take payments."
        )));
    }
    if !doc.invoice && (status == "draft" || status == "cancelled") {
        return Err(posting(format!(
            "Bill {number} must be approved before it can be paid."
        )));
    }
    Ok(())
}

/// The payment a caller-chosen id already made (`existingPayment`).
async fn existing_payment(
    db: &PgPool,
    input: &RecordPaymentInput,
) -> Result<Option<RecordPaymentResult>, PostError> {
    let Some(id) = input.id.as_deref().filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let existing: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(payments),
        " from payments t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(existing) = existing.map(|row| PAYMENTS.js(row)) else {
        return Ok(None);
    };
    if text(&existing, "entityId") != Some(input.entity_id.as_str())
        || !existing["deletedAt"].is_null()
    {
        return Err(posting(format!("Payment id {id} is already used")));
    }
    let allocated: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select invoice_id, bill_id from payment_allocations where payment_id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let currency = match owned(&existing, "currency") {
        Some(currency) => currency,
        None => resolve_entity_base_currency(db, &input.entity_id).await?,
    };
    Ok(Some(RecordPaymentResult {
        payment_id: id.to_owned(),
        journal_entry_id: owned(&existing, "journalEntryId"),
        contact_id: owned(&existing, "contactId").unwrap_or_default(),
        currency,
        documents: allocated
            .iter()
            .map(|(invoice, bill)| document_ref(invoice.as_deref(), bill.as_deref()))
            .collect(),
        undeposited: false,
    }))
}

fn assert_payment_amounts(input: &RecordPaymentInput, withheld: f64) -> Result<(), PostError> {
    if input.amount.is_nan() || input.amount <= 0.0 {
        return Err(posting("Payment amount must be greater than zero"));
    }
    if withheld != 0.0 && (input.received || withheld < 0.0 || withheld > round_money(input.amount))
    {
        return Err(posting(
            "Backup withholding applies to payments to vendors and can not be more than the payment",
        ));
    }
    Ok(())
}

/// A received payment settles invoices; a sent one settles bills or
/// refunds a customer credit note.
fn assert_allocation_shapes(input: &RecordPaymentInput) -> Result<(), PostError> {
    for a in &input.allocations {
        if a.amount.is_nan() || a.amount <= 0.0 {
            return Err(posting("Allocation amounts must be greater than zero"));
        }
        let invoice = a.invoice_id.as_deref().is_some_and(|id| !id.is_empty());
        let bill = a.bill_id.as_deref().is_some_and(|id| !id.is_empty());
        let valid = if input.received {
            invoice && !bill
        } else {
            invoice != bill
        };
        if !valid {
            return Err(posting(if input.received {
                "A received payment can only be allocated to invoices"
            } else {
                "A sent payment can only be allocated to bills"
            }));
        }
    }
    Ok(())
}

/// What a document may still take: what is written off on an
/// `uncollectible` invoice, else its open balance.
fn open_balance_of(doc: &Document) -> f64 {
    if doc.invoice && text(&doc.row, "status") == Some("uncollectible") {
        return written_off_balance(&doc.row);
    }
    amount_of(&doc.row, "balanceDue")
}

fn assert_allocatable(input: &RecordPaymentInput, doc: &Document) -> Result<(), PostError> {
    let kind = if doc.invoice { "invoice" } else { "bill" };
    if text(&doc.row, "entityId") != Some(input.entity_id.as_str()) {
        return Err(posting(format!(
            "Linked {kind} belongs to a different accounting entity"
        )));
    }
    let credit_note = doc.invoice && text(&doc.row, "type") == Some("credit_note");
    if input.received && credit_note {
        return Err(posting(format!(
            "{} is a credit note: the money goes back to the customer. Record a refund (a payment sent) instead.",
            doc.number_or_id()
        )));
    }
    if !input.received && doc.invoice && !credit_note {
        return Err(posting(
            "A sent payment can only be allocated to bills or refund a credit note",
        ));
    }
    assert_payable(doc)
}

/// The realised FX difference on one document of a payment (`FxDifference`).
#[derive(Debug, Clone, PartialEq)]
pub struct FxDifference {
    pub document_id: String,
    pub contact_id: String,
    pub delta: f64,
    pub gain: bool,
    pub fx_account_id: String,
    pub settlement_account_id: String,
}

/// One allocation `planFxDifferences` looks at: the document's id, contact,
/// booked rate, and the amount.
#[derive(Debug, Clone)]
pub struct FxAllocation {
    pub document_id: String,
    pub contact_id: String,
    pub exchange_rate: Value,
    pub amount: f64,
}

/// `planFxDifferences(db, args)`: the FX differences of a payment with their
/// accounts, worked out before the payment posts so a chart without a gain /
/// loss account refuses the payment.
pub async fn plan_fx_differences(
    db: &PgPool,
    entity_id: &str,
    received: bool,
    payment_rate: &str,
    allocations: &[FxAllocation],
) -> Result<Vec<FxDifference>, PostError> {
    let Some(payment_rate) = parse_rate(&json!(payment_rate)) else {
        return Ok(Vec::new());
    };
    let mut differences = Vec::new();
    for a in allocations {
        let Some(document_rate) = parse_rate(&a.exchange_rate) else {
            continue;
        };
        #[allow(clippy::float_cmp)] // `===` on the parsed rates, as TypeScript
        if document_rate == payment_rate {
            continue;
        }
        let delta = calculate_fx_gain_loss(a.amount, payment_rate, document_rate);
        if delta.abs() >= 0.01 {
            differences.push((a.document_id.clone(), a.contact_id.clone(), delta));
        }
    }
    if differences.is_empty() {
        return Ok(Vec::new());
    }
    let accounts = load_entity_accounts(db, entity_id).await?;
    let settlement = if received {
        account_for_role(&accounts, "accounts_receivable", &["1300"])
    } else {
        account_for_role(&accounts, "accounts_payable", &["1600"])
    };
    let Some(settlement) = settlement else {
        return Err(posting(format!(
            "No accounts {} account found for this entity.",
            if received { "receivable" } else { "payable" }
        )));
    };
    let settlement_id = settlement["id"].as_str().unwrap_or_default().to_owned();
    differences
        .into_iter()
        .map(|(document_id, contact_id, delta)| {
            let gain = if received { delta > 0.0 } else { delta < 0.0 };
            let fx = if gain {
                account_for_role(&accounts, "realized_fx_gain", &["8400"])
                    .or_else(|| accounts.by_subtype("other_income"))
            } else {
                account_for_role(&accounts, "realized_fx_loss", &["4950"])
                    .or_else(|| accounts.by_subtype("other_expense"))
            };
            let Some(fx) = fx else {
                let (word, role) = if gain { ("gain", "realized_fx_gain") } else { ("loss", "realized_fx_loss") };
                return Err(posting(format!(
                    "This payment settles a foreign-currency document at another rate than it was booked at, but the chart of accounts has no exchange {word} account. Add an account with the role {role} first."
                )));
            };
            Ok(FxDifference {
                document_id,
                contact_id,
                delta,
                gain,
                fx_account_id: fx["id"].as_str().unwrap_or_default().to_owned(),
                settlement_account_id: settlement_id.clone(),
            })
        })
        .collect()
}

/// `postFxDifferences(db, args)`: a payment's realised FX differences as
/// one entry (so voiding the payment reverses them in one go).
async fn post_fx_differences(
    db: &PgPool,
    entity_id: &str,
    payment_id: &str,
    plan: &[FxDifference],
    date: &str,
    user_id: Option<String>,
) -> Result<(), PostError> {
    if plan.is_empty() {
        return Ok(());
    }
    let mut lines = Vec::new();
    for d in plan {
        let amount = d.delta.abs();
        let description = format!("FX {} adjustment", if d.gain { "gain" } else { "loss" });
        let (debit_account, credit_account) = if d.gain {
            (&d.settlement_account_id, &d.fx_account_id)
        } else {
            (&d.fx_account_id, &d.settlement_account_id)
        };
        lines.push(PostingLine {
            account_id: debit_account.clone(),
            debit: amount,
            contact_id: Some(d.contact_id.clone()),
            description: Some(description.clone()),
            ..PostingLine::default()
        });
        lines.push(PostingLine {
            account_id: credit_account.clone(),
            credit: amount,
            contact_id: Some(d.contact_id.clone()),
            description: Some(description),
            ..PostingLine::default()
        });
    }
    let net = plan
        .iter()
        .fold(0.0, |sum, d| sum + if d.gain { d.delta } else { -d.delta });
    let id = payment_id.to_owned();
    let write: AlsoWrite = Box::new(move |conn, posted| {
        Box::pin(async move {
            sqlx::query("update payments set exchange_difference_entry_id = $1, updated_at = $2::timestamp where id = $3")
                .bind(&posted.journal_entry_id)
                .bind(now())
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            Ok(())
        })
    });
    post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.to_owned(),
            date: date.to_owned(),
            description: format!(
                "FX {} on payment {payment_id}",
                if net >= 0.0 { "gain" } else { "loss" }
            ),
            source_type: "payment_fx_adjustment".to_owned(),
            source_id: Some(payment_id.to_owned()),
            posting_key: Some(format!("payment:{payment_id}:fx")),
            lock_kind: Some(PostingLockKind::General),
            created_by: user_id,
            lines,
            also_write: vec![write],
            ..PostJournalEntryInput::default()
        },
    )
    .await?;
    Ok(())
}

/// Everything the statements written with a payment's entry need (`PaymentWrite`).
#[derive(Debug, Clone)]
struct PaymentWrite {
    input: RecordPaymentInput,
    payment_id: String,
    contact_id: String,
    currency: String,
    exchange_rate: String,
    payment_method: Option<&'static str>,
    check_status: Option<String>,
    withheld: f64,
    allocations: Vec<PaymentAllocationInput>,
    /// Written-off invoices whose receivable a recovery reinstated.
    recovered: Vec<String>,
    fully_allocated: bool,
    now: String,
}

/// The payment, its allocations, the documents' new paid amounts and the
/// bank-line match, written with its entry (`paymentStatements`).
#[allow(clippy::too_many_lines)] // one statement per table, as the worker
fn payment_statements(w: PaymentWrite) -> AlsoWrite {
    Box::new(move |conn, posted| {
        Box::pin(async move {
            let entry_id = posted.journal_entry_id.clone();
            let input = &w.input;
            let single = (w.allocations.len() == 1).then(|| &w.allocations[0]);
            let opt = |v: &Option<String>| v.as_ref().map_or(Value::Null, |v| json!(v));
            let mut row = Map::new();
            for (key, value) in [
                ("id", json!(w.payment_id)),
                ("entityId", json!(input.entity_id)),
                (
                    "type",
                    json!(if input.received { "received" } else { "sent" }),
                ),
                ("amount", json!(to_fixed(input.amount, 2))),
                ("currency", json!(w.currency)),
                ("exchangeRate", json!(w.exchange_rate)),
                ("date", json!(input.date)),
                ("paymentMethod", json!(w.payment_method)),
                ("checkNumber", opt(&input.check_number)),
                ("checkStatus", opt(&w.check_status)),
                (
                    "checkPrintedAt",
                    if w.check_status.as_deref() == Some("printed") {
                        json!(w.now)
                    } else {
                        Value::Null
                    },
                ),
                ("reference", opt(&input.reference)),
                (
                    "invoiceId",
                    single.map_or(Value::Null, |a| opt(&a.invoice_id)),
                ),
                ("billId", single.map_or(Value::Null, |a| opt(&a.bill_id))),
                ("contactId", json!(w.contact_id)),
                ("counterpartyId", json!(w.contact_id)),
                ("bankAccountId", opt(&input.bank_account_id)),
                ("bankTransactionId", opt(&input.bank_transaction_id)),
                ("paymentRunId", opt(&input.payment_run_id)),
                (
                    "backupWithholdingAmount",
                    if w.withheld > 0.0 {
                        json!(to_fixed(w.withheld, 2))
                    } else {
                        Value::Null
                    },
                ),
                ("journalEntryId", json!(entry_id)),
                ("notes", opt(&input.notes)),
                ("isPartial", json!(!w.fully_allocated)),
                ("createdBy", opt(&input.user_id)),
                ("createdAt", json!(w.now)),
                ("updatedAt", json!(w.now)),
            ] {
                row.insert(key.to_owned(), value);
            }
            PAYMENTS
                .insert_raw(&mut *conn, PAYMENTS.values(&row))
                .await?;
            for a in &w.allocations {
                let mut allocation = Map::new();
                for (key, value) in [
                    ("id", json!(generate_id("pal"))),
                    ("entityId", json!(input.entity_id)),
                    ("paymentId", json!(w.payment_id)),
                    ("invoiceId", opt(&a.invoice_id)),
                    ("billId", opt(&a.bill_id)),
                    ("amount", json!(to_fixed(a.amount, 2))),
                    ("createdAt", json!(w.now)),
                    ("updatedAt", json!(w.now)),
                ] {
                    allocation.insert(key.to_owned(), value);
                }
                PAYMENT_ALLOCATIONS
                    .insert_raw(&mut *conn, PAYMENT_ALLOCATIONS.values(&allocation))
                    .await?;
            }
            for a in &w.allocations {
                if let Some(invoice_id) = a.invoice_id.as_deref().filter(|id| !id.is_empty()) {
                    if w.recovered.iter().any(|id| id == invoice_id) {
                        settle_written_off(&mut *conn, invoice_id, a.amount).await?;
                    } else {
                        settle(&mut *conn, true, invoice_id, a.amount).await?;
                    }
                } else if let Some(bill_id) = a.bill_id.as_deref().filter(|id| !id.is_empty()) {
                    settle(&mut *conn, false, bill_id, a.amount).await?;
                }
            }
            if let Some(transaction) = input
                .bank_transaction_id
                .as_deref()
                .filter(|id| !id.is_empty())
            {
                sqlx::query(
                    "update bank_transactions set status = 'reconciled', reconciliation_type = $1, \
                     reconciled_payment_id = $2, reconciled_invoice_id = $3, reconciled_bill_id = $4, \
                     journal_entry_id = $5, contact_id = $6, updated_at = $7::timestamp where id = $8",
                )
                .bind(input.reconciliation_type.as_deref().unwrap_or("manual"))
                .bind(&w.payment_id)
                .bind(single.and_then(|a| a.invoice_id.as_deref()))
                .bind(single.and_then(|a| a.bill_id.as_deref()))
                .bind(&entry_id)
                .bind(&w.contact_id)
                .bind(&w.now)
                .bind(transaction)
                .execute(&mut *conn)
                .await?;
            }
            Ok(())
        })
    })
}

/// `recordPayment(db, input)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn record_payment(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    input: RecordPaymentInput,
) -> Result<RecordPaymentResult, PostError> {
    if let Some(already) = existing_payment(db, &input).await? {
        return Ok(already);
    }
    let withheld = round_money(input.backup_withholding_amount.unwrap_or(0.0));
    assert_payment_amounts(&input, withheld)?;
    assert_allocation_shapes(&input)?;

    // loadAllocatedDocuments
    let ids: Vec<String> = input
        .allocations
        .iter()
        .map(|a| document_id_of(a.invoice_id.as_deref(), a.bill_id.as_deref()))
        .collect();
    let mut seen: Vec<&String> = Vec::new();
    for id in &ids {
        if seen.contains(&id) {
            return Err(posting(
                "Each document can only be allocated once per payment",
            ));
        }
        seen.push(id);
    }
    let invoice_ids: Vec<String> = input
        .allocations
        .iter()
        .filter_map(|a| a.invoice_id.clone().filter(|id| !id.is_empty()))
        .collect();
    let bill_ids: Vec<String> = input
        .allocations
        .iter()
        .filter_map(|a| a.bill_id.clone().filter(|id| !id.is_empty()))
        .collect();
    let mut docs = load_documents(db, true, &invoice_ids).await?;
    docs.extend(load_documents(db, false, &bill_ids).await?);
    let doc_of = |id: &str| docs.iter().rev().find(|(key, _)| key == id).map(|(_, d)| d);

    // buildAllocations
    let mut allocations: Vec<PaymentAllocationInput> = Vec::new();
    let mut allocated_total = 0.0;
    for allocation in &input.allocations {
        let invoice = allocation
            .invoice_id
            .as_deref()
            .is_some_and(|id| !id.is_empty());
        let id = document_id_of(
            allocation.invoice_id.as_deref(),
            allocation.bill_id.as_deref(),
        );
        let Some(doc) = doc_of(&id) else {
            return Err(posting(format!(
                "{} {id} not found",
                if invoice { "Invoice" } else { "Bill" }
            )));
        };
        assert_allocatable(&input, doc)?;
        let open = open_balance_of(doc);
        if allocation.amount > open + 0.005 {
            return Err(posting(format!(
                "The amount allocated to {} ({}) is more than its open balance ({})",
                doc.number_or_id(),
                to_fixed(allocation.amount, 2),
                to_fixed(open, 2)
            )));
        }
        allocated_total = round_money(allocated_total + allocation.amount);
        allocations.push(PaymentAllocationInput {
            invoice_id: invoice.then(|| id.clone()),
            bill_id: (!invoice).then(|| id.clone()),
            amount: allocation.amount,
            contact_id: owned(&doc.row, "contactId").unwrap_or_default(),
        });
    }
    if allocated_total > round_money(input.amount) + 0.005 {
        return Err(posting("Allocations exceed the payment amount"));
    }

    let first_doc = if allocations.is_empty() {
        None
    } else {
        doc_of(&ids[0])
    };
    let contact_id = input
        .contact_id
        .clone()
        .or_else(|| first_doc.and_then(|d| owned(&d.row, "contactId")))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| posting("A payment needs a contact or at least one invoice or bill"))?;
    let base_currency = resolve_entity_base_currency(db, &input.entity_id).await?;
    let currency = input
        .currency
        .clone()
        .or_else(|| first_doc.and_then(|d| owned(&d.row, "currency")))
        .unwrap_or_else(|| base_currency.clone());
    // assertDocumentCurrencies: a payment settles documents in their own currency.
    for a in &allocations {
        let id = document_id_of(a.invoice_id.as_deref(), a.bill_id.as_deref());
        if let Some(doc) = doc_of(&id) {
            let doc_currency = text(&doc.row, "currency");
            if is_foreign_currency(&base_currency, doc_currency)
                && doc_currency != Some(currency.as_str())
            {
                let doc_currency = doc_currency.unwrap_or_default();
                return Err(posting(format!(
                    "{} is in {doc_currency}, so the payment has to be in {doc_currency} too (it is in {currency}).",
                    doc.number_or_id()
                )));
            }
        }
    }
    // resolvePaymentRate: the typed rate, else the rate on the payment date,
    // else the one the document was booked at. Never 1 for another currency.
    let at_millis = millis_of(&input.date).unwrap_or(0);
    let exchange_rate = if is_foreign_currency(&base_currency, Some(&currency)) {
        let typed = input.exchange_rate.as_ref().map(|r| json!(r));
        let resolved = resolve_rate(
            db,
            http,
            RateQuery {
                base_currency: &base_currency,
                currency: &currency,
                at_millis,
                typed: typed.as_ref(),
                use_feed: true,
            },
        )
        .await?;
        #[allow(clippy::float_cmp)]
        let booked = first_doc
            .and_then(|d| d.row.get("exchangeRate"))
            .and_then(parse_rate)
            .filter(|rate| *rate != 1.0)
            .map(format_rate);
        match resolved.map(|r| r.rate).or(booked) {
            Some(rate) => rate,
            None => {
                return Err(posting(missing_rate_message(
                    &currency,
                    &base_currency,
                    &input.date,
                )));
            }
        }
    } else {
        "1".to_owned()
    };
    let payment_method = normalize_payment_method(input.payment_method.as_deref());
    // The realised FX difference per document, accounts looked up before anything posts.
    let fx_allocations: Vec<FxAllocation> = allocations
        .iter()
        .filter_map(|a| {
            let id = document_id_of(a.invoice_id.as_deref(), a.bill_id.as_deref());
            let doc = doc_of(&id)?;
            let foreign = is_foreign_currency(&base_currency, text(&doc.row, "currency"));
            // A refund of a foreign-currency credit note books no FX difference yet.
            let refund = !input.received && a.invoice_id.is_some();
            (foreign && !refund).then(|| FxAllocation {
                document_id: text(&doc.row, "id").unwrap_or_default().to_owned(),
                contact_id: owned(&doc.row, "contactId").unwrap_or_default(),
                exchange_rate: doc.row.get("exchangeRate").cloned().unwrap_or(Value::Null),
                amount: a.amount,
            })
        })
        .collect();
    let fx_plan = plan_fx_differences(
        db,
        &input.entity_id,
        input.received,
        &exchange_rate,
        &fx_allocations,
    )
    .await?;

    // Checks and cash on a US entity wait in Undeposited Funds instead of the bank.
    let accounts = load_entity_accounts(db, &input.entity_id).await?;
    let undeposited_funds = account_for_role(&accounts, "undeposited_funds", &[])
        .and_then(|a| a["id"].as_str())
        .map(str::to_owned);
    let to_undeposited = deposits_undeposited(&input, payment_method, undeposited_funds.is_some())?;
    let lines = build_payment_posting(
        db,
        &PaymentPostingInput {
            entity_id: input.entity_id.clone(),
            received: input.received,
            amount: input.amount,
            currency: Some(currency.clone()),
            exchange_rate: Some(exchange_rate.clone()),
            contact_id: contact_id.clone(),
            bank_account_id: input.bank_account_id.clone(),
            payment_method: payment_method.map(str::to_owned),
            reference: input.reference.clone(),
            money_account_id: if to_undeposited {
                undeposited_funds.clone()
            } else {
                None
            },
            backup_withholding_amount: (withheld > 0.0).then_some(withheld),
        },
        &allocations,
    )
    .await?;
    let check_status = input.check_status.clone().or_else(|| {
        (payment_method == Some("check") && !input.received).then(|| "printed".to_owned())
    });

    let payment_id = input
        .id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| generate_id("pay"));
    let at = now();
    // Written-off invoices: reinstate the receivable so the payment can settle it.
    let mut recoveries: Vec<(String, String)> = Vec::new();
    for a in &allocations {
        let Some(invoice_id) = a.invoice_id.as_deref() else {
            continue;
        };
        if doc_of(invoice_id).is_none_or(|d| text(&d.row, "status") != Some("uncollectible")) {
            continue;
        }
        let invoice: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(invoices),
            " from invoices t where t.id = $1 limit 1"
        ))
        .bind(invoice_id)
        .fetch_optional(db)
        .await?;
        let invoice = invoice.map_or(Value::Null, |row| INVOICES.js(row));
        let (recovery, _) = post_bad_debt_recovery(
            db,
            &invoice,
            a.amount,
            &payment_id,
            input.date.clone(),
            input.user_id.clone(),
        )
        .await?;
        if let Some(entry_id) = recovery.journal_entry_id {
            recoveries.push((invoice_id.to_owned(), entry_id));
        }
    }

    let label = if input.received {
        "Payment received"
    } else {
        "Payment sent"
    };
    let reference_suffix = input
        .reference
        .as_deref()
        .filter(|r| !r.is_empty())
        .map(|r| format!(" {r}"))
        .unwrap_or_default();
    let write = PaymentWrite {
        input: input.clone(),
        payment_id: payment_id.clone(),
        contact_id: contact_id.clone(),
        currency: currency.clone(),
        exchange_rate,
        payment_method,
        check_status,
        withheld,
        allocations: allocations.clone(),
        recovered: recoveries
            .iter()
            .map(|(invoice, _)| invoice.clone())
            .collect(),
        fully_allocated: !allocations.is_empty() && (allocated_total - input.amount).abs() < 0.005,
        now: at,
    };
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: input.entity_id.clone(),
            date: input.date.clone(),
            description: format!("{label}{reference_suffix}"),
            reference: input.reference.clone(),
            source_type: "payment".to_owned(),
            source_id: Some(payment_id.clone()),
            posting_key: Some(format!("payment:{payment_id}")),
            lock_kind: Some(PostingLockKind::General),
            lines,
            created_by: input.user_id.clone(),
            also_write: vec![payment_statements(write)],
            ..PostJournalEntryInput::default()
        },
    )
    .await;
    let posted = match posted {
        Ok(posted) => posted,
        Err(error) => {
            // The payment did not post: take the reinstated receivables back so a retry does not reinstate them twice.
            for (_, entry_id) in &recoveries {
                let undone = reverse_journal_entry(
                    db,
                    ReverseArgs {
                        entry_id: entry_id.clone(),
                        date: input.date.clone(),
                        created_by: input.user_id.clone(),
                        description: Some(format!(
                            "Undo write-off recovery of failed payment {payment_id}"
                        )),
                        ..ReverseArgs::default()
                    },
                )
                .await;
                if let Err(undo) = undone {
                    tracing::error!(error = %undo, "[payments] could not undo write-off recovery");
                }
            }
            return Err(error);
        }
    };

    post_fx_differences(
        db,
        &input.entity_id,
        &payment_id,
        &fx_plan,
        &input.date,
        input.user_id.clone(),
    )
    .await?;

    Ok(RecordPaymentResult {
        payment_id,
        journal_entry_id: posted.journal_entry_id,
        contact_id,
        currency,
        documents: allocations
            .iter()
            .map(|a| document_ref(a.invoice_id.as_deref(), a.bill_id.as_deref()))
            .collect(),
        undeposited: to_undeposited && undeposited_funds.is_some(),
    })
}

/// `voidPayment(db, paymentId, opts)`: reverse its journal entry (and FX
/// entry), put the paid amounts back, release the bank line, soft-delete the
/// payment and its allocations. The payment as it was.
#[allow(clippy::too_many_lines)]
pub async fn void_payment(
    db: &PgPool,
    payment_id: &str,
    user_id: Option<String>,
    date: Option<String>,
) -> Result<Value, PostError> {
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
    if filled(&payment, "depositId").is_some() {
        return Err(posting(
            "This payment is part of a bank deposit. Void the deposit first, then void the payment.",
        ));
    }
    let rows: Vec<(Option<String>, Option<String>, String)> = sqlx::query_as(
        "select invoice_id, bill_id, amount::text from payment_allocations where payment_id = $1 and deleted_at is null",
    )
    .bind(payment_id)
    .fetch_all(db)
    .await?;
    // Payments recorded before allocations existed settle one document with their full amount.
    let allocations: Vec<(Option<String>, Option<String>, f64)> = if !rows.is_empty() {
        rows.into_iter()
            .map(|(invoice, bill, amount)| (invoice, bill, crate::js::parse_float(&amount)))
            .collect()
    } else if filled(&payment, "invoiceId").is_some() || filled(&payment, "billId").is_some() {
        vec![(
            owned(&payment, "invoiceId"),
            owned(&payment, "billId"),
            amount_of(&payment, "amount"),
        )]
    } else {
        Vec::new()
    };
    let at = date.unwrap_or_else(now);
    let invoice_ids: Vec<String> = allocations
        .iter()
        .filter_map(|(invoice, _, _)| invoice.clone().filter(|id| !id.is_empty()))
        .collect();
    // Invoices this payment took out of a write-off: their recovery is reversed too.
    let recovery_entries = find_recovery_entries(db, payment_id, &invoice_ids).await?;
    let recovered: Vec<String> = recovery_entries
        .iter()
        .map(|(invoice, _)| invoice.clone())
        .collect();
    let bank_transaction_id = owned(&payment, "bankTransactionId").filter(|id| !id.is_empty());
    let id = payment_id.to_owned();
    let undo_at = at.clone();
    let undo: AlsoWrite = Box::new(move |conn, _posted| {
        Box::pin(async move {
            sqlx::query("update payments set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2")
                .bind(&undo_at)
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            sqlx::query(
                "update payment_allocations set deleted_at = $1::timestamp, updated_at = $1::timestamp where payment_id = $2",
            )
            .bind(&undo_at)
            .bind(&id)
            .execute(&mut *conn)
            .await?;
            for (invoice, bill, amount) in &allocations {
                if let Some(invoice) = invoice.as_deref().filter(|i| !i.is_empty()) {
                    if recovered.iter().any(|r| r == invoice) {
                        settle_written_off(&mut *conn, invoice, -amount).await?;
                    } else {
                        settle(&mut *conn, true, invoice, -amount).await?;
                    }
                } else if let Some(bill) = bill.as_deref().filter(|b| !b.is_empty()) {
                    settle(&mut *conn, false, bill, -amount).await?;
                }
            }
            sqlx::query(
                "update bank_transactions set status = 'unreconciled', reconciliation_type = null, \
                 reconciled_payment_id = null, reconciled_invoice_id = null, reconciled_bill_id = null, \
                 journal_entry_id = null, updated_at = $1::timestamp \
                 where reconciled_payment_id = $2 or ($3::text is not null and id = $3)",
            )
            .bind(&undo_at)
            .bind(&id)
            .bind(bank_transaction_id.as_deref())
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    });

    for (_, entry_id) in &recovery_entries {
        reverse_journal_entry(
            db,
            ReverseArgs {
                entry_id: entry_id.clone(),
                date: at.clone(),
                created_by: user_id.clone(),
                description: Some(format!("Void write-off recovery of payment {payment_id}")),
                ..ReverseArgs::default()
            },
        )
        .await?;
    }
    if let Some(entry_id) = filled(&payment, "exchangeDifferenceEntryId") {
        reverse_journal_entry(
            db,
            ReverseArgs {
                entry_id: entry_id.to_owned(),
                date: at.clone(),
                created_by: user_id.clone(),
                description: Some(format!("Void FX difference of payment {payment_id}")),
                ..ReverseArgs::default()
            },
        )
        .await?;
    }
    if let Some(entry_id) = filled(&payment, "journalEntryId") {
        let reference = text(&payment, "reference").unwrap_or(payment_id);
        reverse_journal_entry(
            db,
            ReverseArgs {
                entry_id: entry_id.to_owned(),
                date: at,
                created_by: user_id,
                description: Some(format!("Void payment {reference}")),
                also_write: vec![undo],
                ..ReverseArgs::default()
            },
        )
        .await?;
    } else {
        // A payment recorded before payments were posted: nothing to reverse in the ledger.
        let posted = crate::posting::Posted {
            journal_entry_id: String::new(),
            entry_number: String::new(),
        };
        weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
            Box::pin(async move { undo(conn, &posted).await })
        })
        .await?;
    }
    Ok(payment)
}
